"""HTTP helpers for the NyxStrike / CipherStrike agent (Flask microservice)."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urljoin

import httpx

from app.config import Settings

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
