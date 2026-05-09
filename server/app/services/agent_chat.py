"""Mongo persistence + LLM snapshot builder for /workspace/agent-chat."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import Settings
from app.constants import AGENT_CHAT_MESSAGES_COLLECTION, AGENT_CHAT_SESSIONS_COLLECTION
from app.redis_client import get_redis
from app.services.agent_client import (
    AgentUnreachableError,
    agent_path_not_allowed,
    agent_post_json,
    agent_post_sse_stream,
    fetch_agent_health_and_catalog,
    forward_agent_internal_tool_run_sync,
    forward_agent_post_tool,
    normalize_agent_tool_path,
)
from app.services.tool_run_stream import drain_tool_run_stream

logger = logging.getLogger(__name__)

_MAX_AGENT_CHAT_THINKING_CHARS = 100_000
_TOOL_LOG_TAIL_MAX_BYTES = 32 * 1024

# Nmap (and similar) spam stdout with periodic Stats / timing lines — drop before LLM sizing.
_SCANNER_PROGRESS_LINE = re.compile(
    r"^(Stats:|NSE Timing:|Connect Scan Timing:)",
    re.IGNORECASE | re.MULTILINE,
)
_MIDDLE_OMITTED = "\n… [middle omitted] …\n"


def _strip_scanner_progress_noise(text: str) -> str:
    if not text or not text.strip():
        return text
    lines = text.splitlines()
    kept = [ln for ln in lines if not _SCANNER_PROGRESS_LINE.match(ln)]
    return "\n".join(kept) if kept else text


def _head_tail_truncate(s: str, *, max_chars: int, head_fraction: float = 0.22) -> tuple[str, bool]:
    """Keep start + end of ``s`` so conclusions (e.g. nmap tail) survive LLM context limits."""
    if max_chars < 400 or len(s) <= max_chars:
        return s, False
    mid_w = len(_MIDDLE_OMITTED)
    head_n = min(max(500, int(max_chars * head_fraction)), max_chars // 2)
    tail_n = max_chars - head_n - mid_w - 48
    if tail_n < 600:
        tail_n = max(600, max_chars // 2)
        head_n = max(400, max_chars - tail_n - mid_w - 48)
    head = s[:head_n]
    tail = s[-tail_n:] if tail_n > 0 else ""
    omitted = max(0, len(s) - head_n - tail_n)
    return f"{head}{_MIDDLE_OMITTED}({omitted} characters omitted)\n{tail}", True


def _truncate_raw_for_llm(raw: str, max_chars: int) -> str:
    if len(raw) <= max_chars:
        return raw
    out, _ = _head_tail_truncate(raw, max_chars=max_chars, head_fraction=0.12)
    if len(out) <= max_chars:
        return out
    return raw[-max_chars:] + "\n… (truncated at start)"


def _llm_summary_from_result(d: dict[str, Any], http_status: int) -> dict[str, Any]:
    rc = d.get("return_code")
    if rc is None:
        rc = d.get("exit_code")
    return {
        "http_status": http_status,
        "return_code": rc,
        "partial_results": d.get("partial_results"),
        "success": d.get("success"),
        "execution_time": d.get("execution_time"),
    }


def _prepare_agent_tool_result_for_llm(settings: Settings, result_obj: Any, http_status: int) -> str:
    """Serialize agent tool JSON for LLM messages: strip scanner noise, head+tail long streams, add _llm_summary."""
    max_c = int(getattr(settings, "agent_chat_tool_result_max_chars", 56_000) or 56_000)
    if not isinstance(result_obj, dict):
        raw = "" if result_obj is None else str(result_obj)
        return _truncate_raw_for_llm(raw, max_c)

    work: dict[str, Any] = dict(result_obj)
    for key in ("stdout", "stderr"):
        v = work.get(key)
        if isinstance(v, str) and v:
            work[key] = _strip_scanner_progress_noise(v)

    field_budget = max(12_000, int(max_c * 0.82))
    so = work.get("stdout")
    se = work.get("stderr")
    if isinstance(so, str) and so and isinstance(se, str) and se:
        half = max(4000, field_budget // 2)
        work["stdout"], _ = _head_tail_truncate(so, max_chars=half, head_fraction=0.2)
        work["stderr"], _ = _head_tail_truncate(se, max_chars=half, head_fraction=0.2)
    elif isinstance(so, str) and so:
        work["stdout"], _ = _head_tail_truncate(so, max_chars=field_budget, head_fraction=0.2)
    elif isinstance(se, str) and se:
        work["stderr"], _ = _head_tail_truncate(se, max_chars=field_budget, head_fraction=0.2)

    summary = _llm_summary_from_result(work, http_status)
    ordered: dict[str, Any] = {"_llm_summary": summary}
    for k, v in work.items():
        if k != "_llm_summary":
            ordered[k] = v

    text = json.dumps(ordered, indent=2)
    if len(text) <= max_c:
        return text
    if isinstance(ordered.get("stdout"), str):
        ordered["stdout"], _ = _head_tail_truncate(
            str(ordered["stdout"]), max_chars=min(16_000, max_c // 3), head_fraction=0.08
        )
    if isinstance(ordered.get("stderr"), str):
        ordered["stderr"], _ = _head_tail_truncate(
            str(ordered["stderr"]), max_chars=min(8000, max_c // 5), head_fraction=0.1
        )
    text = json.dumps(ordered, indent=2)
    if len(text) <= max_c:
        return text
    tail_keep = max(max_c - 72, 2000)
    return f"… ({len(text) - tail_keep} chars omitted from JSON start)\n" + text[-tail_keep:]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate_tool_log_tail(text: str | None, max_bytes: int = _TOOL_LOG_TAIL_MAX_BYTES) -> tuple[str | None, bool]:
    """Return UTF-8–safe tail of ``text`` capped at ``max_bytes``. Second value is True if truncated."""
    if text is None:
        return None, False
    s = text if isinstance(text, str) else str(text)
    if not s:
        return "", False
    encoded = s.encode("utf-8")
    if len(encoded) <= max_bytes:
        return s, False
    cut = len(encoded) - max_bytes
    tail = encoded[-max_bytes:].decode("utf-8", errors="replace")
    return f"... ({cut} bytes truncated)\n{tail}", True


def _coerce_exit_code(result_obj: dict[str, Any]) -> int | None:
    rc = result_obj.get("return_code")
    if rc is None:
        rc = result_obj.get("exit_code")
    if rc is None:
        return None
    try:
        return int(rc)
    except (TypeError, ValueError):
        return None


def _infer_terminal_run_status(http_status: int, result_obj: Any) -> str:
    if http_status >= 400:
        return "error"
    if isinstance(result_obj, dict) and result_obj.get("success") is False:
        return "error"
    return "done"


def _merge_slot_patch(slots: list[dict[str, Any]], slot_index: int, patch: dict[str, Any]) -> None:
    for i, s in enumerate(slots):
        idx = int(s.get("slot_index", i))
        if idx == int(slot_index):
            slots[i] = {**s, **patch}
            return


def _slot_progress_payload(
    *,
    slot_index: int,
    tool_name: str,
    run_status: str,
    stdout_tail: str | None,
    stderr_tail: str | None,
    stdout_truncated: bool,
    stderr_truncated: bool,
    exit_code: int | None,
    http_status: int | None,
    started_at: str | None,
    finished_at: str | None,
) -> dict[str, Any]:
    return {
        "slot_index": slot_index,
        "tool_name": tool_name,
        "run_status": run_status,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
        "stdout_truncated": stdout_truncated,
        "stderr_truncated": stderr_truncated,
        "exit_code": exit_code,
        "http_status": http_status,
        "run_started_at": started_at,
        "run_finished_at": finished_at,
    }


def _progress_from_completed_run(
    http_status: int,
    result_obj: Any,
    *,
    run_status_override: str | None = None,
) -> dict[str, Any]:
    stdout_raw = ""
    stderr_raw = ""
    exit_code: int | None = None
    if isinstance(result_obj, dict):
        exit_code = _coerce_exit_code(result_obj)
        if result_obj.get("stdout") is not None:
            stdout_raw = str(result_obj.get("stdout") or "")
        if result_obj.get("stderr") is not None:
            stderr_raw = str(result_obj.get("stderr") or "")
    elif result_obj is not None:
        stdout_raw = str(result_obj)

    out_tail, out_trunc = _truncate_tool_log_tail(stdout_raw if stdout_raw else None)
    err_tail, err_trunc = _truncate_tool_log_tail(stderr_raw if stderr_raw else None)
    rs = run_status_override or _infer_terminal_run_status(http_status, result_obj)

    now = _utc_now_iso()
    return {
        "run_status": rs,
        "stdout_tail": out_tail,
        "stderr_tail": err_tail,
        "stdout_truncated": out_trunc,
        "stderr_truncated": err_trunc,
        "exit_code": exit_code,
        "http_status": http_status if http_status else None,
        "run_finished_at": now,
    }


def _sse_tool_batch_slot_progress(batch_message_id: ObjectId | None, body: dict[str, Any]) -> str:
    payload = dict(body)
    if batch_message_id is not None:
        payload["message_id"] = str(batch_message_id)
    return f"data: [TOOL_BATCH_SLOT_PROGRESS]{json.dumps(payload, default=str)}\n\n"


async def _sse_flush_tick() -> None:
    """Yield so Starlette/uvicorn can flush TCP between SSE frames (avoids one giant buffer)."""
    await asyncio.sleep(0)


def _trim_thinking_for_store(raw: str | None) -> str | None:
    if raw is None:
        return None
    t = str(raw).strip()
    if not t:
        return None
    if len(t) > _MAX_AGENT_CHAT_THINKING_CHARS:
        return t[:_MAX_AGENT_CHAT_THINKING_CHARS] + "\n… [truncated]"
    return t


def _parse_think_token_payload(rest: str) -> str:
    rest = rest.strip()
    if not rest:
        return ""
    try:
        tok = json.loads(rest)
        return tok if isinstance(tok, str) else ""
    except json.JSONDecodeError:
        return rest


_CHAT_TOOL_BLOCKLIST = frozenset(
    {
        "ai_analyze_session",
        "ai_recon_session",
        "ai_vuln_session",
        "ai_profiling_session",
        "ai_osint_session",
    },
)

# Workflow slugs aligned with NyxStrike tool_registry.CATEGORIES (for validating router output).
_CHAT_ROUTING_CATEGORY_SLUGS = frozenset(
    {
        "essential",
        "network_recon",
        "web_recon",
        "web_vuln",
        "brute_force",
        "binary",
        "forensics",
        "cloud",
        "osint",
        "exploitation",
        "api",
        "wifi_pentest",
        "database",
        "active_directory",
        "vulnerability_intelligence",
    },
)


def _normalize_router_category_slug(raw: Any) -> str | None:
    s = str(raw or "").strip().lower().replace(" ", "_").replace("-", "_")
    return s if s in _CHAT_ROUTING_CATEGORY_SLUGS else None


def _routing_insert_fragment(hints: dict[str, Any] | None) -> dict[str, Any]:
    if not hints:
        return {}
    frag: dict[str, Any] = {}
    rc = hints.get("router_category")
    if isinstance(rc, str) and rc.strip():
        frag["router_category"] = rc.strip()
    kc = hints.get("keyword_category")
    if isinstance(kc, str) and kc.strip():
        frag["keyword_category"] = kc.strip()
    kf = hints.get("keyword_confidence")
    if isinstance(kf, (int, float)):
        frag["keyword_confidence"] = float(kf)
    return frag


def routing_hints_from_plan_meta(meta: dict[str, Any]) -> dict[str, Any] | None:
    """Build routing dict for insert_message from plan_router_turn meta (may be empty)."""
    if not meta:
        return None
    h = _routing_insert_fragment(
        {
            "router_category": meta.get("router_category"),
            "keyword_category": meta.get("keyword_category"),
            "keyword_confidence": meta.get("keyword_confidence"),
        },
    )
    return h if h else None


async def _fetch_keyword_category_hint(settings: Settings, user_message: str) -> dict[str, Any]:
    """Keyword classify-task (+ cheap LLM tie-break on agent). Informational for UI / meta."""
    try:
        raw = await agent_post_json(
            settings,
            "api/intelligence/classify-task",
            {"description": user_message.strip()},
            timeout_seconds=settings.agent_timeout_seconds,
        )
    except AgentUnreachableError:
        return {}
    if not raw.get("success"):
        return {}
    out: dict[str, Any] = {}
    cat = str(raw.get("category") or "").strip()
    if cat:
        out["keyword_category"] = cat
    try:
        conf = raw.get("confidence")
        if conf is not None:
            out["keyword_confidence"] = float(conf)
    except (TypeError, ValueError):
        pass
    return out


_CONVERSATIONAL_PATTERNS = (
    "thank",
    "thanks",
    "cheers",
    "ok",
    "okay",
    "cool",
    "got it",
    "sounds good",
    "makes sense",
    "perfect",
    "great",
    "nice",
    "hello",
    "hi ",
    "hey ",
    "howdy",
    "what is ",
    "what's ",
    "what are ",
    "explain ",
    "tell me ",
    "how does ",
    "how do ",
    "can you ",
    "could you ",
    "would you ",
    "help me understand",
    "what does ",
    "describe ",
)

# When present, the user is asking for actionable security work — do not skip tool routing.
_OPERATIONAL_SECURITY_HINTS = (
    "http://",
    "https://",
    "pentest",
    "pentesting",
    "penetration test",
    "penetration testing",
    "security test",
    "security assessment",
    "vuln scan",
    "vulnerability scan",
    "vulnerability assessment",
    "security scan",
    "port scan",
    "subdomain",
    "enumeration",
    "enumerate ",
    " recon",
    "reconnaissance",
    "red team",
    "attack surface",
    "sql injection",
    "sqli",
    " xss",
    "csrf",
    "cve-",
    "authorized to",
    "complete pentest",
    "full pentest",
    "run nuclei",
    "run nmap",
    " nuclei",
    " nmap",
    " httpx",
    " burp",
    " ffuf",
    " gobuster",
    " sqlmap",
    " nikto",
    " whatweb",
)

_FALLBACK_SECURITY_TOOLS_ORDER = (
    "httpx",
    "whatweb",
    "nuclei",
    "nikto",
    "ffuf",
    "nmap",
)

_TAIL_MESSAGES_WITH_SUMMARY = 36


def _looks_operational_security(message: str) -> bool:
    lower = message.lower()
    return any(h in lower for h in _OPERATIONAL_SECURITY_HINTS)


def _fallback_security_tool_names(by_name: dict[str, dict[str, Any]], limit: int) -> list[str]:
    out: list[str] = []
    for n in _FALLBACK_SECURITY_TOOLS_ORDER:
        if n in by_name:
            out.append(n)
        if len(out) >= limit:
            break
    return out


def _is_conversational(message: str) -> bool:
    lower = message.lower().strip()
    if _looks_operational_security(lower):
        return False
    if len(lower) < 20:
        return True
    for pat in _CONVERSATIONAL_PATTERNS:
        if lower.startswith(pat) or f" {pat}" in lower:
            return True
    return False


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _truncate_desc(desc: str, limit: int = 100) -> str:
    d = desc.strip().replace("\n", " ")
    return d if len(d) <= limit else d[: max(0, limit - 3)] + "..."


async def create_session(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    title: str,
) -> dict[str, Any]:
    now = _utc_now()
    doc = {
        "organization_id": organization_id,
        "user_id": user_id,
        "title": title.strip() or "New chat",
        "created_at": now,
        "updated_at": now,
    }
    res = await db[AGENT_CHAT_SESSIONS_COLLECTION].insert_one(doc)
    doc["_id"] = res.inserted_id
    return doc


async def list_sessions(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    limit: int = 50,
) -> list[dict[str, Any]]:
    cur = (
        db[AGENT_CHAT_SESSIONS_COLLECTION]
        .find({"organization_id": organization_id, "user_id": user_id})
        .sort("updated_at", -1)
        .limit(limit)
    )
    return await cur.to_list(length=limit)


async def get_session_owned(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
) -> dict[str, Any] | None:
    return await db[AGENT_CHAT_SESSIONS_COLLECTION].find_one(
        {"_id": session_id, "organization_id": organization_id, "user_id": user_id},
    )


async def rename_session(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    title: str,
) -> bool:
    result = await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id, "organization_id": organization_id, "user_id": user_id},
        {"$set": {"title": title.strip(), "updated_at": _utc_now()}},
    )
    return result.modified_count > 0


async def delete_session(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
) -> bool:
    await db[AGENT_CHAT_MESSAGES_COLLECTION].delete_many(
        {"session_id": session_id, "organization_id": organization_id, "user_id": user_id},
    )
    res = await db[AGENT_CHAT_SESSIONS_COLLECTION].delete_one(
        {"_id": session_id, "organization_id": organization_id, "user_id": user_id},
    )
    return res.deleted_count > 0


async def touch_session(db: AsyncIOMotorDatabase, session_id: ObjectId) -> None:
    await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id},
        {"$set": {"updated_at": _utc_now()}},
    )


async def insert_message(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    role: str,
    content: str,
    tool_call: dict[str, Any] | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    batch_execution_state: str | None = None,
    llm_messages_snapshot: list[dict[str, Any]] | None = None,
    thinking_content: str | None = None,
    routing: dict[str, Any] | None = None,
) -> ObjectId:
    doc: dict[str, Any] = {
        "organization_id": organization_id,
        "user_id": user_id,
        "session_id": session_id,
        "role": role,
        "content": content,
        "created_at": _utc_now(),
    }
    doc.update(_routing_insert_fragment(routing))
    if tool_call is not None:
        doc["tool_call"] = tool_call
    if tool_calls is not None:
        doc["tool_calls"] = tool_calls
    if batch_execution_state:
        doc["batch_execution_state"] = batch_execution_state
    if llm_messages_snapshot is not None:
        doc["llm_messages_snapshot"] = llm_messages_snapshot
    tc_store = _trim_thinking_for_store(thinking_content)
    if tc_store is not None:
        doc["thinking_content"] = tc_store
    res = await db[AGENT_CHAT_MESSAGES_COLLECTION].insert_one(doc)
    await touch_session(db, session_id)
    return res.inserted_id


async def list_messages(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    limit: int = 80,
) -> list[dict[str, Any]]:
    cur = (
        db[AGENT_CHAT_MESSAGES_COLLECTION]
        .find({"session_id": session_id, "organization_id": organization_id, "user_id": user_id})
        .sort("created_at", 1)
        .limit(limit)
    )
    return await cur.to_list(length=limit)


async def get_message_owned(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    message_id: ObjectId,
) -> dict[str, Any] | None:
    return await db[AGENT_CHAT_MESSAGES_COLLECTION].find_one(
        {
            "_id": message_id,
            "session_id": session_id,
            "organization_id": organization_id,
            "user_id": user_id,
        },
    )


def build_llm_messages_from_history(
    settings: Settings,
    rows: list[dict[str, Any]],
    *,
    extra_system: str | None = None,
    conversation_summary: str | None = None,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": settings.agent_chat_system_prompt}]
    if conversation_summary and conversation_summary.strip():
        messages.append(
            {
                "role": "system",
                "content": "Compressed earlier conversation (summary):\n" + conversation_summary.strip(),
            },
        )
    if extra_system and extra_system.strip():
        messages.append({"role": "system", "content": extra_system.strip()})
    effective_rows = rows
    if conversation_summary and conversation_summary.strip() and len(rows) > _TAIL_MESSAGES_WITH_SUMMARY:
        effective_rows = rows[-_TAIL_MESSAGES_WITH_SUMMARY:]
    for row in effective_rows:
        role = str(row.get("role") or "user")
        content = str(row.get("content") or "")
        if role not in ("user", "assistant", "tool"):
            role = "user"
        messages.append({"role": role, "content": content})
    return messages


def context_snippet(ctx: dict[str, Any] | None) -> str | None:
    if not ctx:
        return None
    page = str(ctx.get("page") or "").strip()
    sid = str(ctx.get("session_id") or "").strip()
    if not page and not sid:
        return None
    parts = []
    if page:
        parts.append(f"Current UI page: {page}")
    if sid:
        parts.append(f"Related workspace session id (opaque): {sid}")
    return "\n".join(parts)


@dataclass
class RouterTurnResult:
    intent: str  # operational | conversational
    schemas: list[dict[str, Any]] | None
    router_reply: str | None
    meta: dict[str, Any]


async def maybe_refresh_conversation_summary(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    rows: list[dict[str, Any]],
) -> None:
    thr = settings.agent_chat_summarize_after_messages
    if thr <= 0 or len(rows) < thr:
        return
    sess = await get_session_owned(db, organization_id=organization_id, user_id=user_id, session_id=session_id)
    if not sess:
        return
    keep_tail = min(_TAIL_MESSAGES_WITH_SUMMARY, max(thr // 2, 12))
    older = rows[:-keep_tail] if len(rows) > keep_tail else []
    if len(older) < 8:
        return
    buf_parts: list[str] = []
    for row in older[-60:]:
        role = str(row.get("role") or "?")
        buf_parts.append(f"{role}: {str(row.get('content') or '')[:600]}")
    packed = "\n".join(buf_parts)[:12000]
    try:
        summarizer_messages = [
            {
                "role": "system",
                "content": "Summarize the conversation excerpt for LLM context in <=400 words. Preserve targets, "
                "IPs, URLs, tools mentioned, and decisions. Plain prose only.",
            },
            {"role": "user", "content": packed},
        ]
        out = await agent_post_json(
            settings,
            "api/cipherstrike/llm-chat",
            {"messages": summarizer_messages},
            timeout_seconds=settings.agent_timeout_seconds,
        )
    except AgentUnreachableError:
        return
    if not out.get("success"):
        return
    summary = str(out.get("content") or "").strip()
    if not summary:
        return
    await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id},
        {"$set": {"conversation_summary": summary, "updated_at": _utc_now()}},
    )


async def _load_chat_tool_maps(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]] | None:
    """Agent catalog intersected with org-enabled chat tools. None if agent unreachable."""
    try:
        _health, catalog = await fetch_agent_health_and_catalog(settings)
    except AgentUnreachableError:
        return None

    from app.services.organization_tools import get_disabled_tool_names

    disabled = await get_disabled_tool_names(db, organization_id)
    raw_tools = catalog.get("tools")
    if not isinstance(raw_tools, list):
        raw_tools = []

    by_name: dict[str, dict[str, Any]] = {}
    router_catalog: list[dict[str, str]] = []
    for item in raw_tools:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in disabled or name in _CHAT_TOOL_BLOCKLIST:
            continue
        by_name[name] = item
        desc = str(item.get("desc") or "").strip()
        router_catalog.append({"name": name, "desc": _truncate_desc(desc, 100)})

    router_catalog.sort(key=lambda x: x["name"])
    return by_name, router_catalog


async def list_agent_chat_org_tools_catalog(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
) -> list[dict[str, str]] | None:
    """[{name, description}, ...] sorted by name; None if agent unreachable."""
    ctx = await _load_chat_tool_maps(settings, db, organization_id=organization_id)
    if ctx is None:
        return None
    by_name, _router_catalog = ctx
    rows: list[dict[str, str]] = []
    for name in sorted(by_name.keys()):
        item = by_name[name]
        rows.append({"name": name, "description": str(item.get("desc") or "").strip()})
    return rows


def _annotate_fallback_tool_objs(
    by_name: dict[str, dict[str, Any]],
    max_pick: int,
    meta: dict[str, Any],
    reason: str,
) -> list[dict[str, Any]]:
    fb = _fallback_security_tool_names(by_name, max_pick)
    if not fb:
        return []
    meta["fallback_tool_names"] = fb
    meta["fallback_reason"] = reason
    return [by_name[n] for n in fb]


async def _bridge_fetch_tool_schemas(
    settings: Settings,
    tools_objs: list[dict[str, Any]],
    *,
    timeout_seconds: float,
    meta: dict[str, Any],
    router_reply: str | None = None,
) -> RouterTurnResult:
    try:
        schema_resp = await agent_post_json(
            settings,
            "api/cipherstrike/schemas-from-tools",
            {"tools": tools_objs},
            timeout_seconds=timeout_seconds,
        )
    except AgentUnreachableError as e:
        logger.warning("agent_chat schemas unreachable: %s", e.message)
        return RouterTurnResult("operational", None, None, {**meta, "error": e.message})

    if not schema_resp.get("success"):
        return RouterTurnResult("operational", None, None, {**meta, "schemas_error": schema_resp})

    schemas = schema_resp.get("schemas")
    if not isinstance(schemas, list):
        schemas = []
    return RouterTurnResult("operational", schemas if schemas else None, router_reply, meta)


async def plan_router_turn(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_message: str,
    explicit_tool_names: list[str] | None = None,
) -> RouterTurnResult:
    """CipherStrike router — replaces classify-task; returns schemas for main LLM or conversational branch."""
    meta: dict[str, Any] = {}
    max_pick = max(1, settings.agent_router_max_tools)
    explicit: list[str] = []
    seen_in: set[str] = set()
    for raw in explicit_tool_names or []:
        n = str(raw).strip()
        if not n or n in seen_in:
            continue
        seen_in.add(n)
        explicit.append(n)
        if len(explicit) >= max_pick:
            break

    if not explicit and _is_conversational(user_message):
        return RouterTurnResult("conversational", None, None, {"skipped": True, "reason": "conversational_heuristic"})

    ctx = await _load_chat_tool_maps(settings, db, organization_id=organization_id)
    if ctx is None:
        logger.warning("agent_chat catalog unreachable")
        return RouterTurnResult("operational", None, None, {"success": False, "error": "Agent catalog unreachable"})
    by_name, router_catalog = ctx
    meta.update(await _fetch_keyword_category_hint(settings, user_message))

    if explicit:
        meta["tool_selection"] = "explicit"
        meta["explicit_tool_names"] = explicit
        ordered: list[str] = []
        seen_o: set[str] = set()
        for n in explicit:
            if n in by_name and n not in seen_o:
                seen_o.add(n)
                ordered.append(n)
        if not ordered:
            return RouterTurnResult(
                "operational",
                None,
                None,
                {**meta, "explicit_tools_unresolved": True},
            )
        tools_objs = [by_name[n] for n in ordered]
        return await _bridge_fetch_tool_schemas(
            settings,
            tools_objs,
            timeout_seconds=settings.agent_timeout_seconds,
            meta=meta,
            router_reply=None,
        )

    try:
        raw_route = await agent_post_json(
            settings,
            "api/cipherstrike/route-intent",
            {
                "message": user_message.strip(),
                "tools": router_catalog,
                "max_tool_names": settings.agent_router_max_tools,
            },
            timeout_seconds=settings.agent_route_intent_timeout_seconds,
        )
    except AgentUnreachableError as e:
        logger.warning("agent_chat route-intent unreachable: %s", e.message)
        meta["route_intent_error"] = e.message
        fb_objs = _annotate_fallback_tool_objs(by_name, max_pick, meta, "route_intent_unreachable")
        if fb_objs:
            logger.info("agent_chat: using fallback tool schemas after route-intent failure")
            return await _bridge_fetch_tool_schemas(
                settings,
                fb_objs,
                timeout_seconds=settings.agent_timeout_seconds,
                meta=meta,
                router_reply=None,
            )
        return RouterTurnResult("operational", None, None, meta)

    meta["route_intent"] = raw_route
    if raw_route.get("success"):
        rc = _normalize_router_category_slug(raw_route.get("category"))
        if rc:
            meta["router_category"] = rc

    if not raw_route.get("success"):
        fb_objs = _annotate_fallback_tool_objs(by_name, max_pick, meta, "route_intent_unsuccessful")
        if fb_objs:
            logger.info("agent_chat: using fallback tool schemas after unsuccessful route-intent response")
            return await _bridge_fetch_tool_schemas(
                settings,
                fb_objs,
                timeout_seconds=settings.agent_timeout_seconds,
                meta=meta,
                router_reply=None,
            )
        return RouterTurnResult("operational", None, None, meta)

    intent = str(raw_route.get("intent") or "conversational").lower().strip()
    reply = str(raw_route.get("reply") or "").strip() or None
    if intent == "conversational" and _looks_operational_security(user_message):
        intent = "operational"
        reply = None
        meta["intent_override"] = "security_task_hint"

    if intent == "conversational":
        return RouterTurnResult("conversational", None, reply, meta)

    names = raw_route.get("tool_names") or []
    if not isinstance(names, list):
        names = []
    tools_objs = []
    for n in names:
        if isinstance(n, str) and n.strip() in by_name:
            tools_objs.append(by_name[n.strip()])
    if not tools_objs:
        fb = _fallback_security_tool_names(by_name, max_pick)
        if fb:
            meta["fallback_tool_names"] = fb
            tools_objs = [by_name[n] for n in fb]
    if not tools_objs:
        return RouterTurnResult("operational", None, reply, meta)

    return await _bridge_fetch_tool_schemas(
        settings,
        tools_objs,
        timeout_seconds=settings.agent_timeout_seconds,
        meta=meta,
        router_reply=reply,
    )


async def stream_cipherstrike_turn(
    settings: Settings,
    llm_messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    *,
    db: AsyncIOMotorDatabase,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    tenant_roles: list[str] | None = None,
    auto_accept_tools: bool = False,
    routing: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """
    Forward SSE from NyxStrike cipherstrike bridge and persist assistant message on completion.
    Supports TOOL_CALL_PENDING (single) and TOOL_CALL_BATCH_PENDING (multi-slot quorum batch).
    When auto_accept_tools is True (tenant admins only for execution), runs tools immediately
    instead of persisting pending / quorum rows — org-disabled tools stay blocked.

    Progressive tokens require live chunks from the agent. Operational turns with tool schemas on
    non-Gemini backends use the bridge's blocking chat-then-chunk SSE path: expect little or no text
    until the model finishes, then replay in smaller SSE frames.
    """
    roles = list(tenant_roles or [])
    timeout = settings.agent_llm_stream_timeout_seconds
    assistant_chunks: list[str] = []
    thinking_chunks: list[str] = []
    seen_done = False

    path = "api/cipherstrike/llm-stream"
    body: dict[str, Any] = {"messages": llm_messages}
    if tool_schemas:
        body["schemas"] = tool_schemas

    buffer = ""
    try:
        async for text_chunk in agent_post_sse_stream(settings, path, body, timeout_seconds=timeout):
            buffer += text_chunk
            while "\n\n" in buffer:
                raw_event, buffer = buffer.split("\n\n", 1)
                block_to_yield = raw_event
                skip_outer_yield = False
                data_lines = [ln for ln in raw_event.split("\n") if ln.startswith("data: ")]
                payload = ""
                if data_lines:
                    payload = data_lines[0][6:].strip()

                if payload.startswith("[TOOL_CALL_BATCH_PENDING]"):
                    rest = payload[len("[TOOL_CALL_BATCH_PENDING]") :].strip()
                    try:
                        envelope = json.loads(rest)
                    except json.JSONDecodeError:
                        envelope = {}
                    calls = envelope.get("calls") if isinstance(envelope.get("calls"), list) else []
                    slots = []
                    lines: list[str] = []
                    for i, c in enumerate(calls):
                        if not isinstance(c, dict):
                            continue
                        tn = str(c.get("tool_name") or "")
                        args = c.get("arguments") if isinstance(c.get("arguments"), dict) else {}
                        endpoint = str(c.get("endpoint") or "")
                        desc = str(c.get("description") or "")
                        slots.append(
                            {
                                "slot_index": i,
                                "human_decision": None,
                                "tool_name": tn,
                                "arguments": args,
                                "endpoint": endpoint,
                                "description": desc,
                            },
                        )
                        lines.append(f"- **{tn}** — `{json.dumps(args)}`")
                    if auto_accept_tools and slots:
                        approve_slots = [{**s, "human_decision": "approve"} for s in slots]
                        carry_pre_tool_thinking = "".join(thinking_chunks).strip() or None
                        thinking_chunks.clear()
                        async for line in execute_tool_slots_follow_up(
                            settings,
                            db,
                            organization_id=organization_id,
                            user_id=user_id,
                            session_id=session_id,
                            snapshot=list(llm_messages),
                            slots=approve_slots,
                            tenant_roles=roles,
                            batch_message_id=None,
                            carry_thinking=carry_pre_tool_thinking,
                        ):
                            yield line
                        skip_outer_yield = True
                    elif slots:
                        content = (
                            "Tool batch pending human approval (all slots must be approve/reject before execution):\n"
                            + "\n".join(lines)
                        )
                        mid = await insert_message(
                            db,
                            organization_id=organization_id,
                            user_id=user_id,
                            session_id=session_id,
                            role="assistant",
                            content=content,
                            tool_calls=slots,
                            batch_execution_state="awaiting_quorum",
                            llm_messages_snapshot=list(llm_messages),
                            thinking_content="".join(thinking_chunks) or None,
                            routing=routing,
                        )
                        thinking_chunks.clear()
                        out_payload = {"assistant_message_id": str(mid), "calls": calls}
                        block_to_yield = f"data: [TOOL_CALL_BATCH_PENDING] {json.dumps(out_payload)}\n"

                elif payload.startswith("[TOOL_CALL_PENDING]"):
                    rest = payload[len("[TOOL_CALL_PENDING]") :].strip()
                    try:
                        pending_data = json.loads(rest)
                    except json.JSONDecodeError:
                        pending_data = {}
                    tool_name = str(pending_data.get("tool_name") or "")
                    args = pending_data.get("arguments") if isinstance(pending_data.get("arguments"), dict) else {}
                    endpoint = str(pending_data.get("endpoint") or "")
                    desc = str(pending_data.get("description") or "")
                    if auto_accept_tools and tool_name.strip():
                        carry_pre_tool_thinking = "".join(thinking_chunks).strip() or None
                        thinking_chunks.clear()
                        async for line in _auto_execute_single_tool_sse(
                            settings,
                            db,
                            organization_id=organization_id,
                            user_id=user_id,
                            session_id=session_id,
                            snapshot=list(llm_messages),
                            tool_name=tool_name,
                            args=args,
                            endpoint=endpoint,
                            tenant_roles=roles,
                            carry_thinking=carry_pre_tool_thinking,
                        ):
                            yield line
                        skip_outer_yield = True
                    else:
                        intent_text = (
                            f"[Tool call requested: **{tool_name}**]\n"
                            f"Arguments: `{json.dumps(args, indent=2)}`"
                        )
                        tc_state = {
                            "state": "pending",
                            "tool_name": tool_name,
                            "arguments": args,
                            "endpoint": endpoint,
                            "description": desc,
                        }
                        mid = await insert_message(
                            db,
                            organization_id=organization_id,
                            user_id=user_id,
                            session_id=session_id,
                            role="assistant",
                            content=intent_text,
                            tool_call=tc_state,
                            llm_messages_snapshot=list(llm_messages),
                            thinking_content="".join(thinking_chunks) or None,
                            routing=routing,
                        )
                        thinking_chunks.clear()
                        pending_data["assistant_message_id"] = str(mid)
                        block_to_yield = f"data: [TOOL_CALL_PENDING] {json.dumps(pending_data)}\n"

                elif payload == "[DONE]":
                    seen_done = True
                    full_text = "".join(assistant_chunks).strip()
                    think_txt = "".join(thinking_chunks) or None
                    if full_text or think_txt:
                        await insert_message(
                            db,
                            organization_id=organization_id,
                            user_id=user_id,
                            session_id=session_id,
                            role="assistant",
                            content=full_text,
                            thinking_content=think_txt,
                            routing=routing,
                        )
                elif payload.startswith("[ERROR]"):
                    seen_done = True
                    err_txt = payload[7:].lstrip()
                    await insert_message(
                        db,
                        organization_id=organization_id,
                        user_id=user_id,
                        session_id=session_id,
                        role="assistant",
                        content=f"[Error] {err_txt}",
                        thinking_content="".join(thinking_chunks) or None,
                        routing=routing,
                    )
                elif payload.startswith("[THINK_TOKEN]"):
                    rest = payload[len("[THINK_TOKEN]") :].strip()
                    piece = _parse_think_token_payload(rest)
                    if piece:
                        thinking_chunks.append(piece)
                else:
                    try:
                        tok = json.loads(payload)
                        if isinstance(tok, str):
                            assistant_chunks.append(tok)
                    except json.JSONDecodeError:
                        pass

                if not skip_outer_yield:
                    yield block_to_yield + "\n\n"
                    await _sse_flush_tick()

        if buffer.strip():
            yield buffer if buffer.endswith("\n\n") else buffer + "\n\n"
            await _sse_flush_tick()

        if not seen_done and (assistant_chunks or thinking_chunks):
            full_text = "".join(assistant_chunks).strip()
            think_txt = "".join(thinking_chunks) or None
            if full_text or think_txt:
                await insert_message(
                    db,
                    organization_id=organization_id,
                    user_id=user_id,
                    session_id=session_id,
                    role="assistant",
                    content=full_text,
                    thinking_content=think_txt,
                    routing=routing,
                )
                yield "data: [DONE]\n\n"
                await _sse_flush_tick()
    except AgentUnreachableError as e:
        logger.error("agent_chat stream unreachable: %s", e.message)
        yield f"data: [ERROR] {e.message}\n\n"
        yield "data: [DONE]\n\n"


async def merge_tool_batch_decisions(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    message_id: ObjectId,
    decisions: dict[str, str],
) -> tuple[bool, int, int]:
    msg = await get_message_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        message_id=message_id,
    )
    if not msg:
        raise ValueError("message_not_found")
    slots = msg.get("tool_calls")
    if not isinstance(slots, list) or not slots:
        raise ValueError("not_batch")
    if msg.get("batch_execution_state") != "awaiting_quorum":
        raise ValueError("batch_not_awaiting_quorum")

    for key, val in decisions.items():
        try:
            idx = int(str(key).strip())
        except ValueError:
            continue
        v = str(val).lower().strip()
        if v not in ("approve", "reject"):
            continue
        if idx < 0 or idx >= len(slots):
            continue
        slots[idx]["human_decision"] = v

    await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
        {"_id": message_id},
        {"$set": {"tool_calls": slots}},
    )
    decided = sum(1 for s in slots if str(s.get("human_decision") or "").lower() in ("approve", "reject"))
    quorum_met = decided == len(slots)
    return quorum_met, decided, len(slots)


async def _run_one_tool_detailed(
    settings: Settings,
    endpoint: str,
    args: dict[str, Any],
    *,
    emit_slot_progress: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    progress_context: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any], int]:
    """Run one catalog tool via agent HTTP; returns (json_for_llm, progress_fields_for_slot, http_status_code).

    When ``emit_slot_progress`` and ``progress_context`` are set and ``agent_tool_log_streams_enabled``,
    uses ``POST /api/internal/tool-run`` plus Redis Streams for rolling stdout/stderr tails during execution.
    """
    ep = normalize_agent_tool_path(endpoint)
    if agent_path_not_allowed(ep):
        err_obj: dict[str, Any] = {"error": "Tool endpoint is not allowed."}
        se_t, se_tr = _truncate_tool_log_tail("Tool endpoint is not allowed.")
        meta = {
            "run_status": "error",
            "stdout_tail": None,
            "stderr_tail": se_t,
            "stdout_truncated": False,
            "stderr_truncated": se_tr,
            "exit_code": None,
            "http_status": 403,
            "run_finished_at": _utc_now_iso(),
        }
        return json.dumps(err_obj), meta, 403

    use_live = (
        emit_slot_progress is not None
        and isinstance(progress_context, dict)
        and str(progress_context.get("tool_name") or "").strip() != ""
        and bool(getattr(settings, "agent_tool_log_streams_enabled", True))
    )

    if not use_live:
        status_code, content, _ctype = await forward_agent_post_tool(settings, ep, args)
        try:
            result_obj: Any = json.loads(content.decode("utf-8"))
        except Exception:
            raw = content.decode("utf-8", errors="replace")
            result_obj = {"http_status": status_code, "raw": raw}
        result_text = _prepare_agent_tool_result_for_llm(settings, result_obj, status_code)
        meta = _progress_from_completed_run(status_code, result_obj)
        return result_text, meta, status_code

    emit_cb = emit_slot_progress
    assert emit_cb is not None
    assert isinstance(progress_context, dict)

    slot_index = int(progress_context.get("slot_index", 0))
    tool_name = str(progress_context.get("tool_name") or "")
    started_at = progress_context.get("started_at")
    started_at_str = started_at if isinstance(started_at, str) else None

    rid = uuid.uuid4().hex
    stdout_acc = ""
    stderr_acc = ""
    emit_times: list[float] = [0.0]

    async def emit_accumulated(*, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        if not force and (now - emit_times[0]) < 0.1:
            return
        emit_times[0] = now
        out_tail, out_trunc = _truncate_tool_log_tail(stdout_acc if stdout_acc else None)
        err_tail, err_trunc = _truncate_tool_log_tail(stderr_acc if stderr_acc else None)
        await emit_cb(
            _slot_progress_payload(
                slot_index=slot_index,
                tool_name=tool_name,
                run_status="running",
                stdout_tail=out_tail,
                stderr_tail=err_tail,
                stdout_truncated=out_trunc,
                stderr_truncated=err_trunc,
                exit_code=None,
                http_status=None,
                started_at=started_at_str,
                finished_at=None,
            )
        )

    async def on_chunk(evt: dict[str, Any]) -> None:
        nonlocal stdout_acc, stderr_acc
        t = evt.get("type")
        if t == "terminal":
            return
        if t == "stdout":
            stdout_acc += str(evt.get("text") or "")
            await emit_accumulated()
        elif t == "stderr":
            stderr_acc += str(evt.get("text") or "")
            await emit_accumulated()

    run_task = asyncio.create_task(
        asyncio.to_thread(forward_agent_internal_tool_run_sync, settings, ep, args, rid),
    )
    try:
        await drain_tool_run_stream(get_redis(), rid, run_task, on_chunk=on_chunk)
    except Exception:
        logger.exception("tool_run_stream drain failed for tool=%s", tool_name)
    finally:
        await run_task

    await emit_accumulated(force=True)

    try:
        status_code, content = run_task.result()
    except AgentUnreachableError:
        raise
    except Exception as exc:
        logger.exception("internal tool run failed for tool=%s", tool_name)
        se_t, se_tr = _truncate_tool_log_tail(str(exc))
        meta = {
            "run_status": "error",
            "stdout_tail": None,
            "stderr_tail": se_t,
            "stdout_truncated": False,
            "stderr_truncated": se_tr,
            "exit_code": None,
            "http_status": None,
            "run_finished_at": _utc_now_iso(),
        }
        return json.dumps({"error": str(exc)}), meta, 500

    try:
        result_obj = json.loads(content.decode("utf-8"))
    except Exception:
        raw = content.decode("utf-8", errors="replace")
        result_obj = {"http_status": status_code, "raw": raw}
    result_text = _prepare_agent_tool_result_for_llm(settings, result_obj, status_code)
    meta = _progress_from_completed_run(status_code, result_obj)
    return result_text, meta, status_code


async def _run_one_tool(
    settings: Settings,
    endpoint: str,
    args: dict[str, Any],
) -> str:
    text, _meta, _status = await _run_one_tool_detailed(settings, endpoint, args)
    return text


async def execute_tool_slots_follow_up(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    snapshot: list[dict[str, Any]],
    slots: list[dict[str, Any]],
    tenant_roles: list[str],
    batch_message_id: ObjectId | None = None,
    carry_thinking: str | None = None,
) -> AsyncIterator[str]:
    """Persist executions for each slot (approve/reject/blocked), optionally patch batch parent row, stream LLM follow-up."""
    needs_exec = any(str(s.get("human_decision") or "").lower() == "approve" for s in slots)
    if needs_exec and "tenant_admin" not in (tenant_roles or []):
        yield "data: [ERROR] Tenant administrator role required to execute tools\n\n"
        yield "data: [DONE]\n\n"
        return

    from app.services.organization_tools import get_disabled_tool_names

    disabled = await get_disabled_tool_names(db, organization_id)

    ordered = sorted(slots, key=lambda s: int(s.get("slot_index", 0)))

    working_slots: list[dict[str, Any]] = []
    for i, slot in enumerate(ordered):
        d = str(slot.get("human_decision") or "").lower()
        tn = str(slot.get("tool_name") or "").strip()
        row = dict(slot)
        if d == "reject":
            ts = _utc_now_iso()
            row.update(
                {
                    "run_status": "skipped",
                    "run_started_at": ts,
                    "run_finished_at": ts,
                    "stdout_tail": None,
                    "stderr_tail": None,
                    "stdout_truncated": False,
                    "stderr_truncated": False,
                    "exit_code": None,
                    "http_status": None,
                },
            )
        elif d == "approve" and tn in disabled:
            ts = _utc_now_iso()
            row.update(
                {
                    "run_status": "skipped",
                    "run_started_at": ts,
                    "run_finished_at": ts,
                    "stdout_tail": None,
                    "stderr_tail": None,
                    "stdout_truncated": False,
                    "stderr_truncated": False,
                    "exit_code": None,
                    "http_status": None,
                },
            )
        elif d == "approve":
            row.update(
                {
                    "run_status": "queued",
                    "run_started_at": None,
                    "run_finished_at": None,
                    "stdout_tail": None,
                    "stderr_tail": None,
                    "stdout_truncated": False,
                    "stderr_truncated": False,
                    "exit_code": None,
                    "http_status": None,
                },
            )
        working_slots.append(row)

    approve_to_run = [
        s
        for s in working_slots
        if str(s.get("human_decision") or "").lower() == "approve"
        and str(s.get("tool_name") or "").strip() not in disabled
    ]

    batch_filter = (
        {
            "_id": batch_message_id,
            "session_id": session_id,
            "organization_id": organization_id,
            "user_id": user_id,
        }
        if batch_message_id is not None
        else None
    )

    if batch_message_id is not None and batch_filter is not None:
        await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
            batch_filter,
            {"$set": {"tool_calls": working_slots, "batch_execution_state": "executing"}},
        )
        await _sse_flush_tick()

    prog_q: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

    async def exec_approved(slot: dict[str, Any]) -> None:
        idx = int(slot.get("slot_index", 0))
        tn = str(slot.get("tool_name") or "")
        endpoint = str(slot.get("endpoint") or "")
        args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}
        started = _utc_now_iso()
        await prog_q.put(("running", idx, tn, started))

        async def emit_live(payload: dict[str, Any]) -> None:
            await prog_q.put(("stream_progress", idx, tn, payload))

        try:
            result_text, prog, _http = await _run_one_tool_detailed(
                settings,
                endpoint,
                args,
                emit_slot_progress=emit_live,
                progress_context={
                    "slot_index": idx,
                    "tool_name": tn,
                    "started_at": started,
                },
            )
        except Exception as exc:
            logger.exception("batch tool %s", tn)
            se_t, se_tr = _truncate_tool_log_tail(str(exc))
            fin = _utc_now_iso()
            prog = {
                "run_status": "error",
                "stdout_tail": None,
                "stderr_tail": se_t,
                "stdout_truncated": False,
                "stderr_truncated": se_tr,
                "exit_code": None,
                "http_status": None,
                "run_finished_at": fin,
            }
            result_text = json.dumps({"error": str(exc)})
        await prog_q.put(("finished", idx, tn, result_text, prog))

    exec_tasks = [asyncio.create_task(exec_approved(s)) for s in approve_to_run]
    pending_finish = len(exec_tasks)

    async def persist_working_if_batch() -> None:
        if batch_message_id is not None and batch_filter is not None:
            await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
                batch_filter,
                {"$set": {"tool_calls": working_slots, "batch_execution_state": "executing"}},
            )

    results_by_idx: dict[int, str] = {}

    while pending_finish > 0:
        kind, *rest = await prog_q.get()
        if kind == "running":
            idx, tn, started = int(rest[0]), str(rest[1]), str(rest[2])
            patch_run = {
                "run_status": "running",
                "run_started_at": started,
                "stdout_tail": None,
                "stderr_tail": None,
                "stdout_truncated": False,
                "stderr_truncated": False,
                "exit_code": None,
                "http_status": None,
            }
            _merge_slot_patch(working_slots, idx, patch_run)
            await persist_working_if_batch()
            if batch_message_id is not None:
                yield _sse_tool_batch_slot_progress(
                    batch_message_id,
                    _slot_progress_payload(
                        slot_index=idx,
                        tool_name=tn,
                        run_status="running",
                        stdout_tail=None,
                        stderr_tail=None,
                        stdout_truncated=False,
                        stderr_truncated=False,
                        exit_code=None,
                        http_status=None,
                        started_at=started,
                        finished_at=None,
                    ),
                )
                await _sse_flush_tick()
        elif kind == "stream_progress":
            idx_sp = int(rest[0])
            body = dict(rest[2])
            patch_sp = {
                "run_status": str(body.get("run_status") or "running"),
                "stdout_tail": body.get("stdout_tail"),
                "stderr_tail": body.get("stderr_tail"),
                "stdout_truncated": bool(body.get("stdout_truncated")),
                "stderr_truncated": bool(body.get("stderr_truncated")),
                "exit_code": body.get("exit_code"),
                "http_status": body.get("http_status"),
            }
            _merge_slot_patch(working_slots, idx_sp, patch_sp)
            await persist_working_if_batch()
            if batch_message_id is not None:
                yield _sse_tool_batch_slot_progress(batch_message_id, body)
                await _sse_flush_tick()
        elif kind == "finished":
            idx = int(rest[0])
            tn = str(rest[1])
            result_text = str(rest[2])
            prog = dict(rest[3])
            results_by_idx[idx] = result_text
            _merge_slot_patch(working_slots, idx, prog)
            await persist_working_if_batch()
            row = next(
                (s for i, s in enumerate(working_slots) if int(s.get("slot_index", i)) == idx),
                {},
            )
            if batch_message_id is not None:
                yield _sse_tool_batch_slot_progress(
                    batch_message_id,
                    _slot_progress_payload(
                        slot_index=idx,
                        tool_name=tn,
                        run_status=str(prog.get("run_status") or "done"),
                        stdout_tail=prog.get("stdout_tail"),
                        stderr_tail=prog.get("stderr_tail"),
                        stdout_truncated=bool(prog.get("stdout_truncated")),
                        stderr_truncated=bool(prog.get("stderr_truncated")),
                        exit_code=prog.get("exit_code"),
                        http_status=prog.get("http_status"),
                        started_at=row.get("run_started_at") if isinstance(row.get("run_started_at"), str) else None,
                        finished_at=prog.get("run_finished_at")
                        if isinstance(prog.get("run_finished_at"), str)
                        else None,
                    ),
                )
                await _sse_flush_tick()
            pending_finish -= 1

    def _working_row_for_slot_index(si: int) -> dict[str, Any]:
        return next(
            (s for i, s in enumerate(working_slots) if int(s.get("slot_index", i)) == int(si)),
            {},
        )

    follow_tool_msgs: list[dict[str, str]] = []
    updated_slots: list[dict[str, Any]] = []
    for slot in ordered:
        idx = int(slot.get("slot_index", 0))
        tn = str(slot.get("tool_name") or "")
        decision = str(slot.get("human_decision") or "").lower()
        args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}
        cur = _working_row_for_slot_index(idx)

        if decision == "reject":
            skip_txt = f"[Skipped **{tn}** — operator rejected]"
            await insert_message(
                db,
                organization_id=organization_id,
                user_id=user_id,
                session_id=session_id,
                role="tool",
                content=skip_txt,
            )
            follow_tool_msgs.append({"role": "tool", "content": skip_txt})
            updated_slots.append({**cur, "execution_outcome": "rejected"})
            continue

        if tn.strip() in disabled:
            err_txt = json.dumps({"error": "Tool disabled for organization"})
            await insert_message(
                db,
                organization_id=organization_id,
                user_id=user_id,
                session_id=session_id,
                role="assistant",
                content=f"[Tool blocked: **{tn}**]",
            )
            await insert_message(
                db,
                organization_id=organization_id,
                user_id=user_id,
                session_id=session_id,
                role="tool",
                content=err_txt,
            )
            follow_tool_msgs.append({"role": "tool", "content": err_txt})
            updated_slots.append({**cur, "execution_outcome": "blocked"})
            continue

        result_text = results_by_idx.get(idx)
        if result_text is None:
            result_text = json.dumps({"error": "Tool did not return a result"})
        exec_record = (
            f"[Tool executed: **{tn}**]\n"
            f"Arguments: `{json.dumps(args)}`\n"
            f"Result:\n```json\n{result_text}\n```"
        )
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="assistant",
            content=exec_record,
        )
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="tool",
            content=result_text,
        )
        follow_tool_msgs.append({"role": "tool", "content": result_text})
        eo = (
            "error"
            if str(cur.get("run_status") or "") == "error"
            else "completed"
        )
        updated_slots.append({**cur, "execution_outcome": eo})

    if batch_message_id is not None and batch_filter is not None:
        await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
            batch_filter,
            {"$set": {"batch_execution_state": "completed", "tool_calls": updated_slots}},
        )
        await touch_session(db, session_id)

    follow_llm = list(snapshot) + follow_tool_msgs
    async for chunk in stream_follow_up_after_tool(
        settings,
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        llm_messages=follow_llm,
        carry_thinking=carry_thinking,
    ):
        yield chunk


async def _auto_execute_single_tool_sse(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    snapshot: list[dict[str, Any]],
    tool_name: str,
    args: dict[str, Any],
    endpoint: str,
    tenant_roles: list[str],
    carry_thinking: str | None = None,
) -> AsyncIterator[str]:
    if "tenant_admin" not in (tenant_roles or []):
        yield "data: [ERROR] Tenant administrator role required for automatic tool execution\n\n"
        yield "data: [DONE]\n\n"
        return

    from app.services.organization_tools import get_disabled_tool_names

    disabled = await get_disabled_tool_names(db, organization_id)
    if tool_name.strip() in disabled:
        err_txt = json.dumps({"error": "Tool disabled for organization"})
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="assistant",
            content=f"[Tool blocked: **{tool_name}**]",
        )
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="tool",
            content=err_txt,
        )
        follow_llm = list(snapshot) + [{"role": "tool", "content": err_txt}]
        async for chunk in stream_follow_up_after_tool(
            settings,
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            llm_messages=follow_llm,
            carry_thinking=carry_thinking,
        ):
            yield chunk
        return

    try:
        result_text = await _run_one_tool(settings, endpoint, args)
    except Exception as exc:
        logger.exception("auto single tool %s", tool_name)
        result_text = json.dumps({"error": str(exc)})

    exec_record = (
        f"[Tool executed: **{tool_name}**]\n"
        f"Arguments: `{json.dumps(args)}`\n"
        f"Result:\n```json\n{result_text}\n```"
    )
    await insert_message(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        role="assistant",
        content=exec_record,
    )
    await insert_message(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        role="tool",
        content=result_text,
    )

    follow_msgs = list(snapshot) + [{"role": "tool", "content": result_text}]
    async for chunk in stream_follow_up_after_tool(
        settings,
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        llm_messages=follow_msgs,
        carry_thinking=carry_thinking,
    ):
        yield chunk


async def stream_execute_tool_batch(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    message_id: ObjectId,
    tenant_roles: list[str],
) -> AsyncIterator[str]:
    """After quorum: parallel-run approved tools, persist rows, stream follow-up llm-stream."""
    msg = await get_message_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        message_id=message_id,
    )
    if not msg or msg.get("role") != "assistant":
        yield "data: [ERROR] Assistant message not found\n\n"
        yield "data: [DONE]\n\n"
        return
    slots = msg.get("tool_calls")
    if not isinstance(slots, list) or not slots:
        yield "data: [ERROR] Not a tool batch message\n\n"
        yield "data: [DONE]\n\n"
        return
    if msg.get("batch_execution_state") != "awaiting_quorum":
        yield "data: [ERROR] Batch is not awaiting execution\n\n"
        yield "data: [DONE]\n\n"
        return

    decided = sum(1 for s in slots if str(s.get("human_decision") or "").lower() in ("approve", "reject"))
    if decided != len(slots):
        yield "data: [ERROR] Quorum incomplete — set approve/reject on every tool first\n\n"
        yield "data: [DONE]\n\n"
        return

    snapshot = msg.get("llm_messages_snapshot")
    if not isinstance(snapshot, list):
        yield "data: [ERROR] Missing LLM snapshot\n\n"
        yield "data: [DONE]\n\n"
        return

    ordered = sorted(slots, key=lambda s: int(s.get("slot_index", 0)))
    async for chunk in execute_tool_slots_follow_up(
        settings,
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        snapshot=list(snapshot),
        slots=list(ordered),
        tenant_roles=tenant_roles,
        batch_message_id=message_id,
    ):
        yield chunk


async def stream_follow_up_after_tool(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    llm_messages: list[dict[str, Any]],
    carry_thinking: str | None = None,
) -> AsyncIterator[str]:
    timeout = settings.agent_llm_stream_timeout_seconds
    body = {"messages": llm_messages}
    assistant_chunks: list[str] = []
    thinking_chunks: list[str] = []
    if carry_thinking and str(carry_thinking).strip():
        thinking_chunks.append(str(carry_thinking).strip())
    buffer = ""
    seen_done = False
    try:
        async for text_chunk in agent_post_sse_stream(
            settings,
            "api/cipherstrike/llm-stream",
            body,
            timeout_seconds=timeout,
        ):
            buffer += text_chunk
            while "\n\n" in buffer:
                raw_event, buffer = buffer.split("\n\n", 1)
                data_lines = [ln for ln in raw_event.split("\n") if ln.startswith("data: ")]
                payload = data_lines[0][6:].strip() if data_lines else ""
                if payload == "[DONE]":
                    seen_done = True
                    full_text = "".join(assistant_chunks).strip()
                    think_txt = "".join(thinking_chunks) or None
                    if full_text or think_txt:
                        await insert_message(
                            db,
                            organization_id=organization_id,
                            user_id=user_id,
                            session_id=session_id,
                            role="assistant",
                            content=full_text,
                            thinking_content=think_txt,
                        )
                elif payload.startswith("[ERROR]"):
                    seen_done = True
                    err_txt = payload[7:].lstrip()
                    await insert_message(
                        db,
                        organization_id=organization_id,
                        user_id=user_id,
                        session_id=session_id,
                        role="assistant",
                        content=f"[Error] {err_txt}",
                        thinking_content="".join(thinking_chunks) or None,
                    )
                elif payload.startswith("[THINK_TOKEN]"):
                    rest = payload[len("[THINK_TOKEN]") :].strip()
                    piece = _parse_think_token_payload(rest)
                    if piece:
                        thinking_chunks.append(piece)
                else:
                    try:
                        tok = json.loads(payload)
                        if isinstance(tok, str):
                            assistant_chunks.append(tok)
                    except json.JSONDecodeError:
                        pass
                yield raw_event + "\n\n"

        if buffer.strip():
            yield buffer if buffer.endswith("\n\n") else buffer + "\n\n"

        if not seen_done and (assistant_chunks or thinking_chunks):
            full_text = "".join(assistant_chunks).strip()
            think_txt = "".join(thinking_chunks) or None
            if full_text or think_txt:
                await insert_message(
                    db,
                    organization_id=organization_id,
                    user_id=user_id,
                    session_id=session_id,
                    role="assistant",
                    content=full_text,
                    thinking_content=think_txt,
                )
            yield "data: [DONE]\n\n"
    except AgentUnreachableError as e:
        yield f"data: [ERROR] {e.message}\n\n"
        yield "data: [DONE]\n\n"
