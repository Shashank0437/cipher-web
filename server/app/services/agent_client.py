"""HTTP helpers for the NyxStrike / CipherStrike agent (Flask microservice)."""

from __future__ import annotations

import asyncio
import codecs
from typing import Any
from urllib.parse import urljoin

import httpx

from app.config import Settings

# Raw read size for SSE relay. httpx's ``aiter_text()`` wraps ``aiter_bytes()`` which calls
# ``aiter_raw()`` with no chunk_size, so each iteration may match a large TCP/TLS read and
# defer yielding until that buffer fills — the UI sees one burst. Smaller raw reads stream sooner.
_AGENT_SSE_RAW_CHUNK_BYTES = 1024

# Catalog tools call Flask routes under these prefixes (`tool_registry.py` + plugins).
_AGENT_TOOL_ROUTE_PREFIXES: tuple[str, ...] = (
    "/api/tools/",
    "/api/osint/tools/",
    "/api/intelligence/",
    "/api/vuln-intel/",
    "/api/tool/",
    "/api/bot/",  # e.g. /api/bot/bbot (tool_registry)
)


class AgentUnreachableError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _normalized_base(settings: Settings) -> str:
    return settings.agent_base_url.rstrip("/") + "/" if settings.agent_base_url else ""


def _headers(settings: Settings) -> dict[str, str]:
    h: dict[str, str] = {}
    tok = settings.agent_api_token.strip() if settings.agent_api_token else ""
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    bridge = settings.cipherstrike_bridge_secret.strip() if settings.cipherstrike_bridge_secret else ""
    if bridge:
        h["X-CipherStrike-Bridge-Secret"] = bridge
    return h


async def fetch_agent_health_and_catalog(settings: Settings) -> tuple[dict[str, Any], dict[str, Any]]:
    base = _normalized_base(settings)
    if not base:
        raise AgentUnreachableError("Agent URL is empty (set AGENT_MICROSERVICE_URL or AGENT_BASE_URL)")
    timeout = httpx.Timeout(settings.agent_timeout_seconds)
    headers = _headers(settings)
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            health_r, catalog_r = await asyncio.gather(
                client.get(urljoin(base, "health")),
                client.get(urljoin(base, "api/tools")),
            )
    except httpx.TimeoutException:
        raise AgentUnreachableError(f"Timed out contacting agent after {settings.agent_timeout_seconds}s")
    except httpx.RequestError as e:
        raise AgentUnreachableError(f"Cannot reach agent: {e}")

    if health_r.status_code >= 400:
        raise AgentUnreachableError(f"Agent /health returned HTTP {health_r.status_code}")
    if catalog_r.status_code >= 400:
        raise AgentUnreachableError(f"Agent /api/tools returned HTTP {catalog_r.status_code}")
    return health_r.json(), catalog_r.json()


# Categories implemented on the CipherStrike server (no host binary) — same default as workspace tool cards
# when /health has no probe entry for a catalog id.
_AGENT_SERVER_LAYER_CATEGORIES = frozenset({"intelligence", "ai_assist", "vulnerability_intelligence"})


def tool_installed_from_agent_health(health: dict[str, Any], tool_item: dict[str, Any]) -> bool:
    """
    Whether a catalog tool should be treated as runnable on the agent host.

    Uses ``health["tools_status"][name]`` when present (mirrors workspace ``WorkspaceToolCard.active``).
    When absent, Python-only / server-layer tools default to available.
    """
    name = str(tool_item.get("name") or "").strip()
    if not name:
        return False
    category = str(tool_item.get("category") or "uncategorized")
    raw = health.get("tools_status")
    tools_status = raw if isinstance(raw, dict) else {}
    if name in tools_status:
        v = tools_status[name]
        return bool(v) if isinstance(v, bool) else bool(v)
    key_l = name.lower()
    for k, v in tools_status.items():
        if str(k).lower() == key_l:
            return bool(v) if isinstance(v, bool) else bool(v)
    return category in _AGENT_SERVER_LAYER_CATEGORIES


async def post_refresh_tool_availability(settings: Settings) -> dict[str, Any]:
    """Forward to agent POST /api/tools/availability/refresh (forces tool probe pass)."""
    base = _normalized_base(settings)
    if not base:
        raise AgentUnreachableError("Agent URL is empty (set AGENT_MICROSERVICE_URL or AGENT_BASE_URL)")
    timeout = httpx.Timeout(settings.agent_timeout_seconds)
    headers = _headers(settings)
    url = urljoin(base, "api/tools/availability/refresh")
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            r = await client.post(url)
    except httpx.TimeoutException:
        raise AgentUnreachableError(f"Timed out contacting agent after {settings.agent_timeout_seconds}s")
    except httpx.RequestError as e:
        raise AgentUnreachableError(f"Cannot reach agent: {e}")

    if r.status_code >= 400:
        try:
            detail = r.json().get("error") or r.text
        except ValueError:
            detail = r.text or f"HTTP {r.status_code}"
        raise AgentUnreachableError(f"Agent refresh failed ({r.status_code}): {detail}")
    return r.json()


def normalize_agent_tool_path(endpoint: str) -> str:
    ep = endpoint.strip()
    if not ep:
        raise ValueError("endpoint is required")
    if not ep.startswith("/"):
        ep = "/" + ep
    ep = ep.split("?", 1)[0].strip() or "/"
    if ".." in ep or "\x00" in ep:
        raise ValueError("Invalid endpoint path")
    return ep


def agent_path_not_allowed(endpoint: str) -> bool:
    return not any(endpoint.startswith(prefix) for prefix in _AGENT_TOOL_ROUTE_PREFIXES)


async def forward_agent_post_tool(
    settings: Settings,
    path: str,
    payload: dict[str, Any] | None,
) -> tuple[int, bytes, str]:
    """POST JSON to a catalog tool route. Uses ``AGENT_API_TOKEN`` as ``Authorization: Bearer`` when configured."""
    base = _normalized_base(settings)
    if not base:
        raise AgentUnreachableError("Agent URL is empty (set AGENT_MICROSERVICE_URL or AGENT_BASE_URL)")
    timeout = httpx.Timeout(settings.agent_tool_run_timeout_seconds)
    headers = {**_headers(settings), "Content-Type": "application/json"}
    url = urljoin(base, path.lstrip("/"))
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            r = await client.post(url, json=payload if payload else {})
    except httpx.TimeoutException:
        raise AgentUnreachableError(
            f"Timed out running tool on agent after {settings.agent_tool_run_timeout_seconds}s",
        ) from None
    except httpx.RequestError as e:
        raise AgentUnreachableError(f"Cannot reach agent: {e}") from e

    ctype = (
        r.headers.get("content-type", "application/json").split(";")[0].strip() or "application/json"
    )
    return r.status_code, r.content, ctype


async def agent_post_json(
    settings: Settings,
    path: str,
    body: dict[str, Any],
    *,
    timeout_seconds: float,
) -> dict[str, Any]:
    """POST JSON to agent path; parse JSON response body."""
    base = _normalized_base(settings)
    if not base:
        raise AgentUnreachableError("Agent URL is empty (set AGENT_MICROSERVICE_URL or AGENT_BASE_URL)")
    timeout = httpx.Timeout(timeout_seconds)
    headers = {**_headers(settings), "Content-Type": "application/json"}
    url = urljoin(base, path.lstrip("/"))
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            r = await client.post(url, json=body)
    except httpx.TimeoutException:
        raise AgentUnreachableError(f"Timed out calling agent after {timeout_seconds}s") from None
    except httpx.RequestError as e:
        raise AgentUnreachableError(f"Cannot reach agent: {e}") from None

    try:
        data = r.json()
    except ValueError:
        data = {"success": False, "error": r.text or f"HTTP {r.status_code}", "raw_status": r.status_code}
    if r.status_code >= 400 and isinstance(data, dict) and "error" not in data:
        data = {"success": False, "error": data.get("detail") or str(data), "status_code": r.status_code}
    return data if isinstance(data, dict) else {"success": False, "error": "invalid agent JSON"}


async def agent_post_sse_stream(
    settings: Settings,
    path: str,
    body: dict[str, Any],
    *,
    timeout_seconds: float,
):
    """Stream response body as UTF-8 text chunks from agent SSE endpoint."""
    base = _normalized_base(settings)
    if not base:
        raise AgentUnreachableError("Agent URL is empty (set AGENT_MICROSERVICE_URL or AGENT_BASE_URL)")
    timeout = httpx.Timeout(timeout_seconds)
    headers = {**_headers(settings), "Content-Type": "application/json"}
    url = urljoin(base, path.lstrip("/"))
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            async with client.stream("POST", url, json=body) as resp:
                if resp.status_code >= 400:
                    text = (await resp.aread()).decode("utf-8", errors="replace")
                    raise AgentUnreachableError(f"Agent SSE error HTTP {resp.status_code}: {text[:500]}")
                utf8_dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
                async for raw in resp.aiter_raw(chunk_size=_AGENT_SSE_RAW_CHUNK_BYTES):
                    piece = utf8_dec.decode(raw)
                    if piece:
                        yield piece
                tail = utf8_dec.decode(b"", final=True)
                if tail:
                    yield tail
    except httpx.TimeoutException:
        raise AgentUnreachableError(f"Timed out streaming from agent after {timeout_seconds}s") from None
    except httpx.RequestError as e:
        raise AgentUnreachableError(f"Cannot reach agent: {e}") from None


def forward_agent_internal_tool_run_sync(
    settings: Settings,
    catalog_path: str,
    payload: dict[str, Any] | None,
    stream_run_id: str,
) -> tuple[int, bytes]:
    """POST ``/api/internal/tool-run`` (blocking). Agent subprocess logs may stream to Redis in parallel."""
    base = _normalized_base(settings)
    if not base:
        raise AgentUnreachableError("Agent URL is empty (set AGENT_MICROSERVICE_URL or AGENT_BASE_URL)")
    timeout = httpx.Timeout(settings.agent_tool_run_timeout_seconds)
    headers = {**_headers(settings), "Content-Type": "application/json"}
    ep = normalize_agent_tool_path(catalog_path)
    url = urljoin(base, "api/internal/tool-run")
    body = {"path": ep, "json": payload if payload else {}, "stream_run_id": stream_run_id}
    stream_redis_url = str(getattr(settings, "agent_tool_stream_redis_url", "") or "").strip()
    if stream_redis_url:
        body["redis_url"] = stream_redis_url
    try:
        with httpx.Client(timeout=timeout, headers=headers) as client:
            r = client.post(url, json=body)
    except httpx.TimeoutException:
        raise AgentUnreachableError(
            f"Timed out running internal tool on agent after {settings.agent_tool_run_timeout_seconds}s",
        ) from None
    except httpx.RequestError as e:
        raise AgentUnreachableError(f"Cannot reach agent: {e}") from e

    return r.status_code, r.content
