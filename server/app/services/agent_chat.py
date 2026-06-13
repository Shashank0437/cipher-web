"""Mongo persistence + LLM snapshot builder for /workspace/agent-chat."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import Settings
from app.constants import (
    AGENT_CHAT_ATTACHMENTS_COLLECTION,
    AGENT_CHAT_MESSAGES_COLLECTION,
    AGENT_CHAT_SESSIONS_COLLECTION,
)
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
    tool_installed_from_agent_health,
)
from app.services.session_intelligence import recalculate_session_intelligence
from app.services.tool_run_stream import drain_tool_run_stream
from app.services.agent_skills import fetch_skill_blocks_for_meta, inject_followup_skills
from app.services.agent_attack_chains import (
    advance_attack_chain_step,
    attack_chain_followup_context,
    attack_chain_followup_log_line,
    attack_chain_next_step_index,
    attack_chain_next_runnable_step_index,
    attack_chain_next_tool_only,
    filter_attack_chain_steps_to_runnable,
    sync_attack_chain_to_runnable_step,
)

logger = logging.getLogger(__name__)

PENETRATION_REPORT_TOOL_NAME = "penetration-report"

# Tools that only derive artifacts from chat/session state (no host probes). Any session owner runs
# these immediately when tool_execution_mode is ask_permission — avoids infosec-style approval UX.
AGENT_CHAT_TOOLS_SKIP_APPROVAL_PROMPT: frozenset[str] = frozenset({PENETRATION_REPORT_TOOL_NAME})


def _agent_chat_skip_tool_approval_prompt(tool_name: str) -> bool:
    return tool_name.strip() in AGENT_CHAT_TOOLS_SKIP_APPROVAL_PROMPT


def _agent_chat_all_slots_skip_approval_prompt(slots: list[dict[str, Any]]) -> bool:
    if not slots:
        return False
    for s in slots:
        tn = str(s.get("tool_name") or "").strip()
        if not tn or tn not in AGENT_CHAT_TOOLS_SKIP_APPROVAL_PROMPT:
            return False
    return True


_MAX_AGENT_CHAT_THINKING_CHARS = 100_000
_MAX_LLM_TOOL_SCHEMAS_STORE_BYTES = 400_000
_TOOL_LOG_TAIL_MAX_BYTES = 32 * 1024

# Nmap (and similar) spam stdout with periodic Stats / timing lines — drop before LLM sizing.
_SCANNER_PROGRESS_LINE = re.compile(
    r"^(Stats:|NSE Timing:|Connect Scan Timing:)",
    re.IGNORECASE | re.MULTILINE,
)
_MIDDLE_OMITTED = "\n… [middle omitted] …\n"
_EXECUTION_LOG_TAIL_LINES = 50

# Markdown fence for tool JSON in persisted assistant rows. Four backticks so payloads
# containing "```" (e.g. nmap/http stdout inside JSON strings) cannot close the fence early.
TOOL_EXEC_JSON_MARKDOWN_FENCE = "````"


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
    # Avoid duplicating scalar run metadata: those fields live under ``_llm_summary`` only.
    _summary_keys = frozenset(
        {"http_status", "return_code", "exit_code", "partial_results", "success", "execution_time"}
    )
    ordered: dict[str, Any] = {"_llm_summary": summary}
    for k, v in work.items():
        if k == "_llm_summary" or k in _summary_keys:
            continue
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
    execution_log_tail: str | None = None,
    execution_log_truncated: bool = False,
    progress_line: str | None = None,
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
        "execution_log_tail": execution_log_tail,
        "execution_log_truncated": execution_log_truncated,
        "progress_line": progress_line,
    }


def _append_execution_log_lines(
    lines: deque[str],
    text: str | None,
    truncated_ref: list[bool],
) -> None:
    if not text:
        return
    for raw in str(text).splitlines():
        line = raw.strip()
        if not line:
            continue
        if len(lines) == lines.maxlen:
            truncated_ref[0] = True
        lines.append(line)


def _execution_log_tail_from_lines(lines: deque[str]) -> str | None:
    return "\n".join(lines) if lines else None


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
    exec_lines: deque[str] = deque(maxlen=_EXECUTION_LOG_TAIL_LINES)
    exec_truncated = [False]
    if stdout_raw:
        _append_execution_log_lines(exec_lines, "\n".join(f"STDOUT: {ln}" for ln in stdout_raw.splitlines()), exec_truncated)
    if stderr_raw:
        _append_execution_log_lines(exec_lines, "\n".join(f"STDERR: {ln}" for ln in stderr_raw.splitlines()), exec_truncated)

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
        "execution_log_tail": _execution_log_tail_from_lines(exec_lines),
        "execution_log_truncated": exec_truncated[0],
        "progress_line": None,
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


def _trim_llm_tool_schemas_for_store(schemas: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not schemas:
        return None
    out: list[dict[str, Any]] = [s for s in schemas if isinstance(s, dict)]
    if not out:
        return None
    while out:
        try:
            blob = json.dumps(out, default=str).encode("utf-8")
        except (TypeError, ValueError):
            return None
        if len(blob) <= _MAX_LLM_TOOL_SCHEMAS_STORE_BYTES:
            return out
        out = out[:-1]
    return None


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

# Omit from GET /workspace/agent-chat/org-tools UI; still in router catalog + execution paths.
_CHAT_TOOLS_HIDE_FROM_ORG_PICKER = frozenset({PENETRATION_REPORT_TOOL_NAME})

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
        "reporting",
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


async def _fetch_classify_task_meta(settings: Settings, user_message: str) -> dict[str, Any]:
    """classify-task: category, confidence, and compact tool list for fallback routing."""
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
    tools = raw.get("tools")
    if isinstance(tools, list) and tools:
        out["classify_tools"] = tools
    return out


async def _fetch_keyword_category_hint(settings: Settings, user_message: str) -> dict[str, Any]:
    """Alias for classify-task meta fragment (category + tools for fallback)."""
    return await _fetch_classify_task_meta(settings, user_message)


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
    "create a report",
    "generate report",
    "pdf report",
    "penetration test report",
    "penetration report",
    "security report",
    "executive summary",
    "write up the findings",
    "write-up",
    "export report",
    "subdomain",
    "subfinder",
    "amass",
    "use both",
    "run both",
)

_CONTEXTUAL_TOOL_FOLLOW_UP_RE = re.compile(
    r"\b(both|them|those|these|the two|two tools|use both|run both|do both|yes|yep|yeah|"
    r"okay|ok|sure|go ahead|please do|run them|use them|those tools|use those|run those|"
    r"fine use|proceed|go for it|do it)\b",
    re.IGNORECASE,
)

_TOOL_PICK_QUESTION_RE = re.compile(
    r"\b(which|what)\s+(tool|tools)\b|\b(tool|tools)\s+(should|can|do|would)\s+i\b",
    re.IGNORECASE,
)
_EXPLICIT_RUN_TOOL_RE = re.compile(
    r"\b(run|execute|launch|start)\s+(the\s+)?(scan|tool|test|pentest|nikto|nuclei|nmap|httpx)\b|"
    r"\b(scan|pentest)\s+(this|the|that)\b|"
    r"\b(use|run)\s+(nmap|nikto|nuclei|httpx|subfinder|amass|ffuf|gobuster|sqlmap)\b",
    re.IGNORECASE,
)
_SKIPPED_TOOL_RE = re.compile(r"\[Skipped \*\*([^*]+)\*\* — operator rejected\]", re.IGNORECASE)
_EXECUTED_TOOL_RE = re.compile(r"\[Tool executed: \*\*([^*]+)\*\*\]", re.IGNORECASE)

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


_SHORT_TOOL_APPROVAL_RE = re.compile(
    r"\b(run|scan|execute|approve|yes|yep|yeah|ok|okay|continue|go|start|launch|pentest|"
    r"nmap|httpx|nuclei|ffuf|gobuster|sqlmap|nikto|burp|curl)\b",
    re.IGNORECASE,
)


def _looks_like_short_tool_approval(message: str) -> bool:
    lower = message.lower().strip()
    if "http://" in lower or "https://" in lower:
        return True
    return bool(_SHORT_TOOL_APPROVAL_RE.search(message))


def _looks_like_contextual_tool_follow_up(message: str, rows: list[dict[str, Any]]) -> bool:
    """Short affirmations (e.g. "ok use both") after a security turn — need assistant context for routing."""
    lower = message.lower().strip()
    if len(lower) > 80:
        return False
    if not _CONTEXTUAL_TOOL_FOLLOW_UP_RE.search(lower):
        return False
    return session_suggests_security_follow_up(rows, tail=12)


def _looks_like_tool_pick_question(message: str) -> bool:
    """Advisory 'which tool' asks — recommend tools in prose, do not auto-launch a full batch."""
    if not _TOOL_PICK_QUESTION_RE.search(message):
        return False
    return not _EXPLICIT_RUN_TOOL_RE.search(message)


def _session_tool_outcomes(rows: list[dict[str, Any]], *, tail: int = 32) -> tuple[set[str], set[str]]:
    rejected: set[str] = set()
    completed: set[str] = set()
    for m in rows[-tail:]:
        content = str(m.get("content") or "")
        for match in _SKIPPED_TOOL_RE.finditer(content):
            rejected.add(match.group(1).strip().lower())
        for match in _EXECUTED_TOOL_RE.finditer(content):
            completed.add(match.group(1).strip().lower())
        slots = m.get("tool_calls")
        if isinstance(slots, list):
            for slot in slots:
                if not isinstance(slot, dict):
                    continue
                tn = str(slot.get("tool_name") or "").strip().lower()
                if not tn:
                    continue
                eo = str(slot.get("execution_outcome") or "").lower()
                hd = str(slot.get("human_decision") or "").lower()
                if eo == "rejected" or hd == "reject":
                    rejected.add(tn)
                elif eo in ("done", "completed", "success"):
                    completed.add(tn)
    completed -= rejected
    return rejected, completed


def infer_retry_rejected_tool_names(rows: list[dict[str, Any]]) -> list[str]:
    """Tools the operator rejected in this session and has not successfully run since."""
    rejected, completed = _session_tool_outcomes(rows)
    pending = sorted(rejected - completed)
    return pending


def looks_like_retry_rejected_tools(message: str, rows: list[dict[str, Any]]) -> bool:
    if not _looks_like_contextual_tool_follow_up(message, rows):
        return False
    return bool(infer_retry_rejected_tool_names(rows))


def retry_rejected_tools_system_note(tool_names: list[str]) -> str:
    joined = ", ".join(tool_names)
    return (
        "Operator follow-up: run only the tools they previously rejected in approval "
        f"({joined}). Do not re-run tools that already completed in this session. "
        "Call only those tool functions with the same target as before."
    )


def filter_tool_batch_calls(
    calls: list[dict[str, Any]],
    *,
    only_tool_names: frozenset[str] | None = None,
    exclude_tool_names: frozenset[str] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for c in calls:
        if not isinstance(c, dict):
            continue
        tn = str(c.get("tool_name") or "").strip().lower()
        if not tn:
            continue
        if only_tool_names is not None and tn not in only_tool_names:
            continue
        if exclude_tool_names and tn in exclude_tool_names:
            continue
        args = c.get("arguments") if isinstance(c.get("arguments"), dict) else {}
        try:
            args_key = json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)
        except Exception:
            args_key = str(args)
        key = (tn, args_key)
        if key in seen:
            logger.warning("agent_chat: dropping duplicate batch tool call name=%r args=%s", tn, args_key)
            continue
        seen.add(key)
        out.append(c)
    return out


def _is_conversational(message: str) -> bool:
    lower = message.lower().strip()
    if _looks_like_tool_pick_question(message):
        return True
    if _looks_operational_security(lower):
        return False
    if _looks_like_short_tool_approval(message):
        return False
    for pat in _CONVERSATIONAL_PATTERNS:
        if lower.startswith(pat) or f" {pat}" in lower:
            return True
    if len(lower) < 20:
        return True
    return False


def session_suggests_security_follow_up(rows: list[dict[str, Any]], *, tail: int = 18) -> bool:
    buf = ""
    for m in rows[-tail:]:
        buf += str(m.get("content") or "") + "\n"
    lower = buf.lower()
    if "http://" in lower or "https://" in lower:
        return True
    if "[tool executed" in lower or "tool call requested" in lower or "tool batch pending" in lower:
        return True
    return any(h in lower for h in _OPERATIONAL_SECURITY_HINTS)


def _augment_router_user_message(rows: list[dict[str, Any]], current: str, *, max_chars: int = 1200) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for m in reversed(rows[-14:]):
        role = str(m.get("role") or "")
        if role not in ("user", "assistant"):
            continue
        t = str(m.get("content") or "").strip()
        if not t or t in seen:
            continue
        if role == "assistant" and ("[Tool " in t or "[TOOL_" in t or "Tool batch pending" in t):
            continue
        seen.add(t)
        label = "User" if role == "user" else "Assistant"
        parts.append(f"[{label}]\n{t}")
        if len(parts) >= 8:
            break
    parts.reverse()
    block = "\n\n".join(parts)
    if len(block) > max_chars:
        block = block[-max_chars:]
    return f"{block}\n\n[Latest user message]\n{current}".strip()


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
    executed_by: str | None = None,
) -> dict[str, Any]:
    now = _utc_now()
    doc = {
        "organization_id": organization_id,
        "user_id": user_id,
        "title": title.strip() or "New chat",
        "created_at": now,
        "updated_at": now,
    }
    if executed_by:
        doc["executed_by"] = executed_by
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
        .find({"organization_id": organization_id})
        .sort("updated_at", -1)
        .limit(limit)
    )
    rows = await cur.to_list(length=limit)
    user_ids = list({r["user_id"] for r in rows if r.get("user_id")})
    if user_ids:
        users = await db.users.find({"_id": {"$in": user_ids}}).to_list(length=len(user_ids))
        user_map = {u["_id"]: u.get("username") or u.get("email") or "Unknown" for u in users}
        for r in rows:
            uid = r.get("user_id")
            if uid in user_map:
                r["executed_by"] = user_map[uid]
    return rows


async def get_session_owned(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
) -> dict[str, Any] | None:
    doc = await db[AGENT_CHAT_SESSIONS_COLLECTION].find_one(
        {"_id": session_id, "organization_id": organization_id},
    )
    if doc:
        uid = doc.get("user_id")
        if uid:
            user_doc = await db.users.find_one({"_id": uid})
            if user_doc:
                doc["executed_by"] = user_doc.get("username") or user_doc.get("email") or "Unknown"
    return doc


async def rename_session(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    title: str,
) -> bool:
    result = await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id, "organization_id": organization_id},
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
    await db[AGENT_CHAT_ATTACHMENTS_COLLECTION].delete_many(
        {"session_id": session_id, "organization_id": organization_id},
    )
    await db[AGENT_CHAT_MESSAGES_COLLECTION].delete_many(
        {"session_id": session_id, "organization_id": organization_id},
    )
    res = await db[AGENT_CHAT_SESSIONS_COLLECTION].delete_one(
        {"_id": session_id, "organization_id": organization_id},
    )
    return res.deleted_count > 0


async def touch_session(db: AsyncIOMotorDatabase, session_id: ObjectId) -> None:
    await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id},
        {"$set": {"updated_at": _utc_now()}},
    )


async def touch_session_ui_context(
    db: AsyncIOMotorDatabase,
    session_id: ObjectId,
    ctx: dict[str, Any] | None,
) -> None:
    """Persist last dashboard context (page, workspace session_id) for report generation."""
    await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id},
        {"$set": {"last_ui_context": ctx or {}, "updated_at": _utc_now()}},
    )


def _build_report_transcript_for_chat(
    rows: list[dict[str, Any]],
    *,
    max_chars: int,
) -> tuple[str, bool]:
    """Serialize messages for penetration-report; head+tail if over max_chars."""
    parts: list[str] = []
    for row in rows:
        role = str(row.get("role") or "?")
        content = str(row.get("content") or "")
        parts.append(f"## {role}\n{content}")
    full = "\n\n".join(parts)
    if len(full) <= max_chars:
        return full, False
    out, _ = _head_tail_truncate(full, max_chars=max_chars, head_fraction=0.22)
    return out, True


async def enrich_penetration_report_tool_args(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    args: dict[str, Any],
) -> dict[str, Any]:
    out = dict(args) if isinstance(args, dict) else {}
    sess = await get_session_owned(
        db, organization_id=organization_id, user_id=user_id, session_id=session_id
    )
    summary = str((sess or {}).get("conversation_summary") or "").strip()
    ctx_raw = (sess or {}).get("last_ui_context")
    ui_ctx = context_snippet(ctx_raw if isinstance(ctx_raw, dict) else None) or ""

    rows = await list_messages(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        limit=200,
    )
    main, truncated = _build_report_transcript_for_chat(
        rows,
        max_chars=int(getattr(settings, "agent_chat_report_transcript_max_chars", 200_000) or 200_000),
    )
    blocks: list[str] = []
    if summary:
        blocks.append("## Rolling summary (compressed earlier thread)\n" + summary)
    blocks.append("## Full message log\n" + main)
    transcript = "\n\n".join(blocks)
    if truncated:
        transcript += "\n\n[Note: message log exceeded size budget; middle section omitted via head/tail.]\n"

    out["session_transcript"] = transcript
    if ui_ctx:
        out["ui_context"] = ui_ctx
    return out


async def persist_agent_chat_pdf_attachment(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    filename: str,
    pdf_bytes: bytes,
) -> ObjectId:
    doc: dict[str, Any] = {
        "organization_id": organization_id,
        "user_id": user_id,
        "session_id": session_id,
        "filename": (filename or "report.pdf").strip() or "report.pdf",
        "content_type": "application/pdf",
        "data": pdf_bytes,
        "created_at": _utc_now(),
    }
    res = await db[AGENT_CHAT_ATTACHMENTS_COLLECTION].insert_one(doc)
    return res.inserted_id


async def get_agent_chat_attachment_owned(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    attachment_id: ObjectId,
) -> dict[str, Any] | None:
    return await db[AGENT_CHAT_ATTACHMENTS_COLLECTION].find_one(
        {
            "_id": attachment_id,
            "session_id": session_id,
            "organization_id": organization_id,
        }
    )


def attachments_from_tool_result_json(result_text: str) -> list[dict[str, Any]] | None:
    try:
        obj = json.loads(result_text)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    aid = obj.get("attachment_id")
    if not aid:
        return None
    fn = obj.get("filename") or "penetration_report.pdf"
    return [
        {
            "id": str(aid),
            "filename": str(fn),
            "content_type": "application/pdf",
        }
    ]


async def _strip_store_report_pdf_after_agent_json(
    result_obj: Any,
    *,
    tool_name: str,
    chat_tool_context: tuple[AsyncIOMotorDatabase, ObjectId, ObjectId, ObjectId] | None,
    http_status: int,
) -> None:
    if (
        http_status >= 400
        or tool_name != PENETRATION_REPORT_TOOL_NAME
        or not isinstance(result_obj, dict)
        or not result_obj.get("success")
    ):
        return
    b64 = result_obj.get("pdf_base64")
    if not isinstance(b64, str) or not b64.strip():
        return
    try:
        raw_pdf = base64.b64decode(b64.strip())
    except Exception:
        result_obj.pop("pdf_base64", None)
        return
    result_obj.pop("pdf_base64", None)
    if not chat_tool_context or not raw_pdf:
        return
    db, organization_id, user_id, session_id = chat_tool_context
    fn = str(result_obj.get("filename") or "penetration_report.pdf").strip() or "penetration_report.pdf"
    # Remove filename from the result so the LLM doesn't echo it as a download link;
    # the frontend attachment card is the sole download affordance.
    # result_obj.pop("filename", None)
    try:
        aid = await persist_agent_chat_pdf_attachment(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            filename=fn,
            pdf_bytes=raw_pdf,
        )
        result_obj["attachment_id"] = str(aid)
    except Exception:
        logger.exception("agent_chat: failed to persist penetration-report PDF")


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
    llm_tool_schemas: list[dict[str, Any]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    tool_name: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
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
    if tool_name:
        doc["tool_name"] = tool_name
    if tool_call is not None:
        doc["tool_call"] = tool_call
    if tool_calls is not None:
        doc["tool_calls"] = tool_calls
    if batch_execution_state:
        doc["batch_execution_state"] = batch_execution_state
    if llm_messages_snapshot is not None:
        doc["llm_messages_snapshot"] = llm_messages_snapshot
    ts_store = _trim_llm_tool_schemas_for_store(llm_tool_schemas)
    if ts_store is not None:
        doc["llm_tool_schemas"] = ts_store
    tc_store = _trim_thinking_for_store(thinking_content)
    if tc_store is not None:
        doc["thinking_content"] = tc_store
    if attachments:
        doc["attachments"] = attachments
    res = await db[AGENT_CHAT_MESSAGES_COLLECTION].insert_one(doc)
    # Estimate and update session token count
    now_utc = _utc_now()
    if role == "user":
        # Bypass metrics updates for user messages to avoid double counting.
        # Just update the updated_at timestamp.
        await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
            {"_id": session_id},
            {"$set": {"updated_at": now_utc}}
        )
    elif role == "assistant":
        if input_tokens is not None and output_tokens is not None:
            await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
                {"_id": session_id},
                {
                    "$inc": {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "num_calls": 1,
                    },
                    "$set": {"updated_at": now_utc},
                }
            )
        else:
            in_tok = 1000 + len(content) // 4
            if llm_tool_schemas:
                in_tok += len(llm_tool_schemas) * 400
            out_tok = 10 + len(content) // 4
            if thinking_content:
                out_tok += len(thinking_content) // 4
            await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
                {"_id": session_id},
                {
                    "$inc": {
                        "input_tokens": in_tok,
                        "output_tokens": out_tok,
                        "num_calls": 1,
                    },
                    "$set": {"updated_at": now_utc},
                }
            )
    else:
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
        .find({"session_id": session_id, "organization_id": organization_id})
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
        },
    )


def tool_result_llm_message(content: str, tool_name: str = "") -> dict[str, Any]:
    """OpenAI-compatible tool result for follow-up LLM turns (requires ``name`` or ``tool_call_id``)."""
    tn = (tool_name or "").strip() or "tool"
    return {"role": "tool", "content": content, "name": tn}


def assistant_and_tool_result_pair(
    tool_name: str,
    arguments: dict[str, Any] | None,
    result_content: str,
    *,
    call_id: str | None = None,
) -> list[dict[str, Any]]:
    """Produce the [assistant(tool_calls), tool(result)] pair to append to follow-up history.

    Some LLM providers (esp. OpenAI strict tool mode) reject a bare tool-role message that
    doesn't follow a matching assistant tool_calls message. Always emit the pair together so
    the model sees a coherent function-call turn.
    """
    tn = (tool_name or "").strip() or "tool"
    cid = call_id or _new_synthetic_call_id()
    args = arguments if isinstance(arguments, dict) else {}
    return [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": cid,
                    "type": "function",
                    "function": {"name": tn, "arguments": json.dumps(args)},
                },
            ],
        },
        {"role": "tool", "tool_call_id": cid, "name": tn, "content": result_content},
    ]


def _fallback_post_tool_summary(llm_messages: list[dict[str, Any]], reason: str = "") -> str:
    """Local post-tool summary when the follow-up LLM stream fails after tools completed."""
    tool_rows = [
        m for m in llm_messages
        if isinstance(m, dict) and str(m.get("role") or "") == "tool"
    ]
    names: list[str] = []
    notes: list[str] = []
    for m in tool_rows[-8:]:
        name = str(m.get("name") or m.get("tool_name") or "tool").strip() or "tool"
        if name not in names:
            names.append(name)
        content = str(m.get("content") or "")
        note = ""
        try:
            obj = json.loads(content)
            if isinstance(obj, dict):
                if obj.get("error"):
                    note = f"{name}: {str(obj.get('error'))[:180]}"
                else:
                    summary = obj.get("_llm_summary")
                    if isinstance(summary, dict):
                        bits = []
                        for key in ("status", "success", "exit_code", "stdout_nonempty_lines"):
                            if summary.get(key) is not None:
                                bits.append(f"{key}={summary.get(key)}")
                        if bits:
                            note = f"{name}: " + ", ".join(bits)
                    if not note:
                        raw = obj.get("raw") or obj.get("stdout") or obj.get("result") or obj.get("output")
                        if raw:
                            note = f"{name}: {str(raw)[:180]}"
        except Exception:
            compact = re.sub(r"\s+", " ", content).strip()
            if compact:
                note = f"{name}: {compact[:180]}"
        if note:
            notes.append(note)

    tool_label = ", ".join(names) if names else "The completed tool run"
    text = (
        f"{tool_label} finished and the execution details were saved to the session. "
        "The automatic follow-up summary could not be generated because the LLM stream disconnected."
    )
    if notes:
        text += " Latest persisted result snapshot: " + " | ".join(notes[:4])
    if reason:
        text += f" Follow-up error: {reason[:220]}"
    return text


# Regex strips legacy assistant messages that embedded the executed-tool markdown.
# The fence may be three or four backticks; allow any opener of >= 3 of the same character.
_LEGACY_TOOL_EXECUTED_MARKDOWN_RE = re.compile(
    r"\[Tool executed:\s*\*\*[^*]+\*\*\][\s\S]*?(?:`{3,}json[\s\S]*?`{3,}|$)",
    re.IGNORECASE,
)
_LEGACY_TOOL_CALL_REQUESTED_RE = re.compile(
    r"\[Tool call requested:\s*\*\*[^*]+\*\*\][\s\S]*?(?:`[^`]*`|$)",
    re.IGNORECASE,
)
# Marker contents we now persist instead of the imitable markdown — strip from LLM history.
_INTERNAL_TOOL_MARKER_RE = re.compile(r"^_tool_call_(?:pending|completed):[^_]+_$")


def _strip_legacy_tool_markdown(content: str) -> str:
    """Remove imitable tool markdown blocks from old assistant messages before re-feeding to LLM."""
    if not content:
        return content
    cleaned = _LEGACY_TOOL_EXECUTED_MARKDOWN_RE.sub("", content)
    cleaned = _LEGACY_TOOL_CALL_REQUESTED_RE.sub("", cleaned)
    return cleaned.strip()


def _assistant_row_to_openai(row: dict[str, Any], call_id: str) -> dict[str, Any] | None:
    """Convert an assistant row into an OpenAI-format message.

    - Confirmed/rejected tool_call → assistant with structured tool_calls field (content="")
    - Pending tool_call → omit entirely (the LLM doesn't need to see still-pending calls; the
      follow-up turn that includes the result will provide structured tool_calls + tool result)
    - Batch tool_calls list → assistant with one tool_calls entry per slot that has a result
    - Plain text assistant → as-is after stripping legacy markdown
    Returns None when the row should be skipped (e.g. pending tool call, marker-only content).
    """
    tc = row.get("tool_call") if isinstance(row.get("tool_call"), dict) else None
    tcs = row.get("tool_calls") if isinstance(row.get("tool_calls"), list) else None
    content = str(row.get("content") or "")

    # Skip marker-only content (no tool_call/tool_calls fields means stale marker; nothing to send)
    if not tc and not tcs and _INTERNAL_TOOL_MARKER_RE.match(content.strip()):
        return None

    # Single tool_call message
    if tc:
        state = str(tc.get("state") or "").lower()
        tn = str(tc.get("tool_name") or "").strip()
        args = tc.get("arguments") if isinstance(tc.get("arguments"), dict) else {}
        if not tn:
            return None
        if state == "pending":
            # Still awaiting human decision; nothing useful for the LLM yet
            return None
        if state in ("rejected",):
            # Represent as a tool_call + tool result (rejection note) so the model sees the
            # full decision in its native structured format
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {"name": tn, "arguments": json.dumps(args)},
                    },
                ],
            }
        # Confirmed (executed): emit structured tool_calls
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": tn, "arguments": json.dumps(args)},
                },
            ],
        }

    # Batch tool_calls
    if tcs:
        calls_out: list[dict[str, Any]] = []
        for i, slot in enumerate(tcs):
            if not isinstance(slot, dict):
                continue
            tn = str(slot.get("tool_name") or "").strip()
            if not tn:
                continue
            decision = str(slot.get("human_decision") or "").lower()
            # Skip slots that are not decided (pending human decision)
            # so they don't appear as tool_calls without a matching tool-result message.
            # Only include approved or explicitly rejected slots (which have tool result messages).
            if decision not in ("approve", "reject"):
                continue
            args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}
            # Prefer persisted call_id (set by execute_tool_slots_follow_up at batch execution
            # time) so rebuilds match what the previous turn's follow-up LLM saw.
            slot_call_id = str(slot.get("call_id") or "").strip() or f"{call_id}_{i}"
            calls_out.append(
                {
                    "id": slot_call_id,
                    "type": "function",
                    "function": {"name": tn, "arguments": json.dumps(args)},
                },
            )
        if not calls_out:
            return None
        return {"role": "assistant", "content": "", "tool_calls": calls_out}

    # Plain text assistant — strip legacy markdown so it doesn't poison the model
    cleaned = _strip_legacy_tool_markdown(content)
    if not cleaned:
        return None
    return {"role": "assistant", "content": cleaned}


def build_llm_messages_from_history(
    settings: Settings,
    rows: list[dict[str, Any]],
    *,
    extra_system: str | None = None,
    conversation_summary: str | None = None,
    base_system_prompt: str | None = None,
) -> list[dict[str, Any]]:
    """Reconstruct an OpenAI-compatible message list from persisted Mongo rows.

    Critical: assistant messages with structured tool_call/tool_calls are emitted in
    OpenAI's native `tool_calls` shape (NOT as stringified markdown text). This prevents
    the model from imitating its own previous "[Tool executed: ...]" markdown as plain
    text on subsequent turns. Legacy rows (pre-refactor) with markdown content get the
    markdown stripped before being fed to the LLM.
    """
    base = (base_system_prompt or settings.agent_chat_system_prompt).strip()
    messages: list[dict[str, Any]] = [{"role": "system", "content": base}]
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

    # Track the last assistant message we emitted with tool_calls so we can attach an "id"
    # to subsequent tool-role messages that lack one (OpenAI requires tool_call_id linkage).
    last_assistant_tool_call_ids: list[tuple[str, str]] = []  # [(call_id, tool_name), ...]

    for row in effective_rows:
        role = str(row.get("role") or "user")
        row_id = str(row.get("_id") or row.get("id") or "")
        if role == "user":
            content = str(row.get("content") or "")
            if content:
                messages.append({"role": "user", "content": content})
            continue

        if role == "assistant":
            call_id = row_id or _new_synthetic_call_id()
            out = _assistant_row_to_openai(row, call_id)
            if out is None:
                continue
            messages.append(out)
            # Remember tool_call ids for the next tool messages to link to
            if "tool_calls" in out:
                last_assistant_tool_call_ids = [
                    (str(tc.get("id") or ""), str(((tc.get("function") or {}).get("name") or "")))
                    for tc in out["tool_calls"]
                    if isinstance(tc, dict)
                ]
            else:
                last_assistant_tool_call_ids = []
            continue

        if role == "tool":
            content = str(row.get("content") or "")
            if not content:
                continue
            tn = str(row.get("tool_name") or row.get("name") or "").strip()
            tn_lower = tn.lower()
            entry: dict[str, Any] = {"role": "tool", "content": content}
            if tn:
                entry["name"] = tn
            # Best-effort tool_call_id linkage: match by tool_name (case-insensitive) against
            # the most recent assistant tool_calls block. If a match exists, use it and consume it.
            matched = False
            for i, (cid, ctn) in enumerate(last_assistant_tool_call_ids):
                if ctn and cid and ctn.strip().lower() == tn_lower:
                    entry["tool_call_id"] = cid
                    last_assistant_tool_call_ids.pop(i)
                    matched = True
                    break
            if not matched and tn:
                # No preceding assistant tool_calls slot to link to. This usually means a legacy
                # row or a tool result that the assistant emitted without going through the
                # function-call schema. Drop the entry — passing a tool-role message without a
                # paired assistant tool_calls turn breaks strict providers (OpenAI in strict mode).
                logger.debug(
                    "build_llm_messages: orphan tool message tool_name=%r dropped (no preceding tool_calls)",
                    tn,
                )
                continue
            messages.append(entry)
            continue

        # Unknown role: drop it (don't pollute LLM context with weird shapes)
        continue

    return messages


def _new_synthetic_call_id() -> str:
    """Synthetic tool_call_id for transient pairing. Full UUID hex to avoid collisions in
    high-volume batch scenarios where many ids are generated in the same turn."""
    import uuid as _uuid
    return f"call_{_uuid.uuid4().hex}"


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
    """Agent catalog intersected with org-enabled chat tools that report installed on the agent host. None if agent unreachable."""
    try:
        health, catalog = await fetch_agent_health_and_catalog(settings)
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
        if not tool_installed_from_agent_health(health, item):
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
        if name in _CHAT_TOOLS_HIDE_FROM_ORG_PICKER:
            continue
        item = by_name[name]
        rows.append({"name": name, "description": str(item.get("desc") or "").strip()})
    return rows


def _tool_objs_from_classify_meta(
    by_name: dict[str, dict[str, Any]],
    meta: dict[str, Any],
    limit: int,
) -> list[dict[str, Any]]:
    """Intersect classify-task tool names with org-enabled installed catalog."""
    raw_tools = meta.get("classify_tools")
    if not isinstance(raw_tools, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_tools:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in seen:
            continue
        if name not in by_name:
            continue
        seen.add(name)
        out.append(by_name[name])
        if len(out) >= limit:
            break
    return out


def _fallback_tool_objs(
    by_name: dict[str, dict[str, Any]],
    max_pick: int,
    meta: dict[str, Any],
    reason: str,
) -> list[dict[str, Any]]:
    """Prefer classify-task category tools; else fixed security tool order."""
    classify_objs = _tool_objs_from_classify_meta(by_name, meta, max_pick)
    if classify_objs:
        meta["fallback_tool_names"] = [str(o.get("name") or "") for o in classify_objs]
        meta["fallback_reason"] = reason
        meta["fallback_source"] = "classify_task"
        return classify_objs
    fb = _fallback_security_tool_names(by_name, max_pick)
    if not fb:
        return []
    meta["fallback_tool_names"] = fb
    meta["fallback_reason"] = reason
    meta["fallback_source"] = "fixed_order"
    return [by_name[n] for n in fb]


async def _bridge_fetch_tool_schemas(
    settings: Settings,
    tools_objs: list[dict[str, Any]],
    *,
    timeout_seconds: float,
    meta: dict[str, Any],
    router_reply: str | None = None,
    intent: str = "operational",
) -> RouterTurnResult:
    """Fetch OpenAI tool schemas and workflow skill blocks in parallel."""
    meta_out = dict(meta)

    async def _schemas_coro() -> dict[str, Any]:
        try:
            return await agent_post_json(
                settings,
                "api/cipherstrike/schemas-from-tools",
                {"tools": tools_objs},
                timeout_seconds=timeout_seconds,
            )
        except AgentUnreachableError as e:
            return {"success": False, "error": e.message, "_agent_unreachable": True}

    schemas_task = _schemas_coro()
    skills_task = fetch_skill_blocks_for_meta(settings, meta_out, intent=intent)
    schema_resp, skill_blocks = await asyncio.gather(schemas_task, skills_task)

    if skill_blocks:
        meta_out["skill_injection_blocks"] = skill_blocks

    if schema_resp.get("_agent_unreachable"):
        logger.warning("agent_chat schemas unreachable: %s", schema_resp.get("error"))
        return RouterTurnResult("operational", None, None, {**meta_out, "error": schema_resp.get("error")})

    if not schema_resp.get("success"):
        return RouterTurnResult("operational", None, None, {**meta_out, "schemas_error": schema_resp})

    schemas = schema_resp.get("schemas")
    if not isinstance(schemas, list):
        schemas = []
    return RouterTurnResult("operational", schemas if schemas else None, router_reply, meta_out)


async def _augment_follow_schemas_for_attack_chain(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    organization_id: ObjectId,
    batch_only: frozenset[str] | None,
    pruned_schemas: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    """Ensure the next attack-chain tool is callable even if it was not in the original turn schemas."""
    if not batch_only:
        return pruned_schemas
    return await fetch_attack_chain_tool_schemas(
        settings,
        db,
        organization_id=organization_id,
        next_tool_names=batch_only,
    )


async def fetch_attack_chain_tool_schemas(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    next_tool_names: frozenset[str],
) -> list[dict[str, Any]] | None:
    """Fetch OpenAI tool schemas for the next attack-chain step only (ignores decaying snapshots)."""
    if not next_tool_names:
        return None
    ctx = await _load_chat_tool_maps(settings, db, organization_id=organization_id)
    if ctx is None:
        return None
    by_name, _ = ctx
    objs = [by_name[n] for n in sorted(next_tool_names) if n in by_name]
    if not objs:
        return None
    rt = await _bridge_fetch_tool_schemas(
        settings,
        objs,
        timeout_seconds=settings.agent_timeout_seconds,
        meta={},
        intent="operational",
    )
    schemas = rt.schemas if rt.schemas else []
    return schemas if schemas else None


def _is_sequential_attack_chain(sess: dict[str, Any] | None) -> bool:
    if not sess:
        return False
    ac = sess.get("attack_chain")
    return isinstance(ac, dict) and bool(ac.get("sequential"))


async def fetch_runnable_tool_name_set(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
) -> frozenset[str] | None:
    """Lowercase tool names that are org-enabled and installed on the agent host."""
    ctx = await _load_chat_tool_maps(settings, db, organization_id=organization_id)
    if ctx is None:
        return None
    by_name, _ = ctx
    return frozenset(k.strip().lower() for k in by_name.keys() if k.strip())


async def sanitize_attack_chain_plan_for_org(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    steps: list[dict[str, Any]],
    phases: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[str], list[str], list[dict[str, Any]]]:
    """Filter plan steps to runnable tools; returns (steps, tools, omitted, phases)."""
    available = await fetch_runnable_tool_name_set(settings, db, organization_id=organization_id)
    if not available:
        return steps, _tool_names_from_steps_list(steps), [], phases or []
    return filter_attack_chain_steps_to_runnable(steps, available, phases)


def _tool_names_from_steps_list(steps: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for step in steps:
        if not isinstance(step, dict):
            continue
        name = str(step.get("tool") or step.get("name") or "").strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


async def resolve_attack_chain_follow_schemas(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    sess: dict[str, Any],
    rows: list[dict[str, Any]],
    legacy_pruned: list[dict[str, Any]] | None,
    session_id: ObjectId | None = None,
) -> tuple[list[dict[str, Any]] | None, frozenset[str] | None]:
    """Rebuild follow-up schemas from session plan; skips unavailable tools."""
    if not _is_sequential_attack_chain(sess):
        return legacy_pruned, None

    available = await fetch_runnable_tool_name_set(settings, db, organization_id=organization_id)
    if not available:
        logger.warning("attack_chain_followup: agent catalog unreachable; using legacy schemas")
        return legacy_pruned, None

    runnable_idx, skipped = (
        await sync_attack_chain_to_runnable_step(
            db,
            session_id,
            sess=sess,
            rows=rows,
            available_names=available,
        )
        if session_id is not None
        else (attack_chain_next_runnable_step_index(sess, rows, available), [])
    )

    if runnable_idx is None:
        logger.info(
            attack_chain_followup_log_line(
                sess,
                rows,
                schemas_offered=[],
                batch_only=None,
                reason="plan_complete_or_no_runnable_tools",
            )
        )
        return None, None

    batch_only = attack_chain_next_tool_only(sess, rows, available_names=available)
    if not batch_only:
        return None, None

    schemas = await fetch_attack_chain_tool_schemas(
        settings,
        db,
        organization_id=organization_id,
        next_tool_names=batch_only,
    )
    offered = [
        str((s.get("function") or {}).get("name") or s.get("name") or "").strip()
        for s in (schemas or [])
        if isinstance(s, dict)
    ]
    reason: str | None = None
    if not schemas:
        reason = "tool_not_in_catalog"
    elif skipped:
        reason = "skipped_unavailable"

    logger.info(
        attack_chain_followup_log_line(
            sess,
            rows,
            schemas_offered=offered,
            batch_only=batch_only,
            reason=reason,
            runnable_index=runnable_idx,
        )
    )
    return schemas, batch_only


_TARGET_HINT_RE = re.compile(r"https?://\S+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\b")

# Pronouns / references that point at a target the user mentioned earlier.
_PRONOUN_TARGET_RE = re.compile(
    r"\b(same|this|that|it|the\s+target|same\s+target|the\s+same|previous\s+target)\b",
    re.IGNORECASE,
)


def _clean_target_token(tok: str) -> str:
    tok = (tok or "").strip().strip(".,;:!?\"'`")
    tok = tok.rstrip("/}")
    for tail in ("\"}", "'}", "\")", "')", ".com\"}", ".org\"}"):
        if tok.endswith(tail) and len(tok) > len(tail):
            tok = tok[: -len(tail) + (4 if tail.startswith(".") else 0)]
            break
    return tok.strip().strip(".,;:!?\"'`")


def recent_target_from_rows(rows: list[dict[str, Any]] | None, *, current_user_message: str = "") -> str:
    """Return the most recent target (URL / IP / hostname) mentioned in the conversation, or ''.

    Looks at: user content, assistant content, tool content, and structured tool_call /
    tool_calls argument values. This makes pronoun resolution work for both legacy markdown
    rows and the new structured-only format.
    """
    if not rows:
        return ""
    cur_msg_norm = (current_user_message or "").strip()
    skipped_current = False

    def _try_extract(text: str) -> str:
        for match in _TARGET_HINT_RE.finditer(text or ""):
            tok = _clean_target_token(match.group(0))
            if not tok or tok.lower() in {"e.g", "i.e"}:
                continue
            return tok
        return ""

    for m in reversed(rows[-32:]):
        role = str(m.get("role") or "")
        content = str(m.get("content") or "").strip()
        if role == "user" and not skipped_current and cur_msg_norm and content == cur_msg_norm:
            skipped_current = True
            continue
        # Check structured tool_call / tool_calls fields first (new format)
        if role == "assistant":
            tc = m.get("tool_call") if isinstance(m.get("tool_call"), dict) else None
            if tc:
                hit = _try_extract(json.dumps(tc.get("arguments") or {}))
                if hit:
                    return hit
            tcs = m.get("tool_calls") if isinstance(m.get("tool_calls"), list) else None
            if tcs:
                for slot in tcs:
                    if isinstance(slot, dict):
                        hit = _try_extract(json.dumps(slot.get("arguments") or {}))
                        if hit:
                            return hit
        if not content:
            continue
        hit = _try_extract(content)
        if hit:
            return hit
    return ""


def target_from_text(text: str) -> str:
    for match in _TARGET_HINT_RE.finditer(text or ""):
        tok = _clean_target_token(match.group(0))
        if not tok or tok.lower() in {"e.g", "i.e"}:
            continue
        return tok
    return ""


def message_references_pronoun_target(user_message: str) -> bool:
    return bool(_PRONOUN_TARGET_RE.search(user_message or ""))


def _build_router_context(rows: list[dict[str, Any]] | None, *, current_user_message: str = "") -> str:
    """Compact recent user+assistant turns into a short context string for the router LLM.

    Strategy:
    - Walks the recent history (last 16 messages) excluding the current user message.
    - Includes user turns, plain assistant turns, AND extracts target hints (URLs / IPs / hostnames)
      from tool-execution markup so the router can resolve "same" / "this" references.
    - Surfaces the most recent target found as a dedicated line so the router can't miss it.
    """
    if not rows:
        return ""
    cur_msg_norm = (current_user_message or "").strip()
    parts: list[str] = []
    seen_targets: list[str] = []  # ordered, most recent first

    def _maybe_record_targets(text: str) -> None:
        for m in _TARGET_HINT_RE.finditer(text or ""):
            tok = m.group(0)
            # Strip JSON / markup punctuation that ended up captured.
            tok = tok.strip().strip(".,;:!?\"'`")
            tok = tok.rstrip("/}")  # trailing slash or JSON closer
            # Strip a single trailing quote-plus-brace fragment that often appears in tool markup.
            for tail in ("\"}", "'}", "\")", "')", ".com\"}", ".org\"}"):
                if tok.endswith(tail) and len(tok) > len(tail):
                    tok = tok[: -len(tail) + (4 if tail.startswith(".") else 0)]
                    break
            tok = tok.strip().strip(".,;:!?\"'`")
            if not tok or tok.lower() in {"e.g", "i.e"}:
                continue
            # Dedup (most recent wins)
            if tok not in seen_targets:
                seen_targets.append(tok)

    # Walk last 16 rows from newest to oldest. Skip the current user message (last user row matching).
    skipped_current = False
    for m in reversed(rows[-16:]):
        role = str(m.get("role") or "")
        content = str(m.get("content") or "").strip()
        # Mine targets from the structured tool_call / tool_calls fields (new format).
        if role == "assistant":
            tc = m.get("tool_call") if isinstance(m.get("tool_call"), dict) else None
            if tc:
                _maybe_record_targets(json.dumps(tc.get("arguments") or {}))
            tcs = m.get("tool_calls") if isinstance(m.get("tool_calls"), list) else None
            if tcs:
                for slot in tcs:
                    if isinstance(slot, dict):
                        _maybe_record_targets(json.dumps(slot.get("arguments") or {}))
        if not content:
            continue
        if role == "user" and not skipped_current and cur_msg_norm and content.strip() == cur_msg_norm:
            skipped_current = True
            continue
        if role == "tool":
            # Tool result messages often carry the target/URL; mine them for hints only.
            _maybe_record_targets(content)
            continue
        # Marker-only assistant content: skip (no useful prose) but already mined tool_call above.
        if role == "assistant" and _INTERNAL_TOOL_MARKER_RE.match(content):
            continue
        if role == "assistant" and ("[Tool " in content or "[TOOL_" in content or "Tool batch pending" in content):
            # Legacy markdown: mine for targets, but don't include the markup text.
            _maybe_record_targets(content)
            continue
        if role not in ("user", "assistant"):
            continue
        # Useful prose turn — keep it.
        _maybe_record_targets(content)
        if len(content) > 400:
            content = content[:400] + "…"
        label = "User" if role == "user" else "Assistant"
        parts.append(f"{label}: {content}")
        if len(parts) >= 4:
            break
    parts.reverse()
    block = "\n".join(parts)
    if seen_targets:
        # Surface the most recent target prominently so the router can resolve pronouns.
        target_line = f"Most recent target(s) in this conversation: {', '.join(seen_targets[:3])}"
        block = (block + "\n" + target_line).strip() if block else target_line
    return block


async def plan_router_turn(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_message: str,
    explicit_tool_names: list[str] | None = None,
    rows: list[dict[str, Any]] | None = None,
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

    if not explicit and _looks_like_tool_pick_question(user_message):
        meta_pick: dict[str, Any] = {"intent_override": "tool_pick_question"}
        ctx_pick = await _load_chat_tool_maps(settings, db, organization_id=organization_id)
        if ctx_pick is None:
            return RouterTurnResult("conversational", None, None, {**meta_pick, "error": "Agent catalog unreachable"})
        _by_pick, router_catalog_pick = ctx_pick
        meta_pick.update(await _fetch_keyword_category_hint(settings, user_message))
        try:
            route_intent_pick_payload: dict[str, Any] = {
                "message": user_message.strip(),
                "tools": router_catalog_pick,
                "max_tool_names": settings.agent_router_max_tools,
            }
            pick_context = _build_router_context(rows, current_user_message=user_message)
            if pick_context:
                route_intent_pick_payload["context"] = pick_context
            raw_pick = await agent_post_json(
                settings,
                "api/cipherstrike/route-intent",
                route_intent_pick_payload,
                timeout_seconds=settings.agent_route_intent_timeout_seconds,
            )
        except AgentUnreachableError as e:
            return RouterTurnResult("conversational", None, None, {**meta_pick, "route_intent_error": e.message})
        meta_pick["route_intent"] = raw_pick
        reply_pick = ""
        if raw_pick.get("success"):
            reply_pick = str(raw_pick.get("reply") or "").strip()
            names_pick = raw_pick.get("tool_names") or []
            if not reply_pick and isinstance(names_pick, list) and names_pick:
                reply_pick = (
                    "For web server vulnerability testing on that target, common choices are: "
                    + ", ".join(str(n) for n in names_pick[:8] if isinstance(n, str) and str(n).strip())
                    + ". Say which to run (or approve a batch) when you are ready to execute."
                )
        return RouterTurnResult("conversational", None, reply_pick or None, meta_pick)

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
            intent="operational",
        )

    router_context = _build_router_context(rows, current_user_message=user_message)
    try:
        route_intent_payload: dict[str, Any] = {
            "message": user_message.strip(),
            "tools": router_catalog,
            "max_tool_names": settings.agent_router_max_tools,
        }
        if router_context:
            route_intent_payload["context"] = router_context
        raw_route = await agent_post_json(
            settings,
            "api/cipherstrike/route-intent",
            route_intent_payload,
            timeout_seconds=settings.agent_route_intent_timeout_seconds,
        )
    except AgentUnreachableError as e:
        logger.warning("agent_chat route-intent unreachable: %s", e.message)
        meta["route_intent_error"] = e.message
        fb_objs = _fallback_tool_objs(by_name, max_pick, meta, "route_intent_unreachable")
        if fb_objs:
            logger.info("agent_chat: using fallback tool schemas after route-intent failure")
            return await _bridge_fetch_tool_schemas(
                settings,
                fb_objs,
                timeout_seconds=settings.agent_timeout_seconds,
                meta=meta,
                router_reply=None,
                intent="operational",
            )
        return RouterTurnResult("operational", None, None, meta)

    meta["route_intent"] = raw_route
    if raw_route.get("success"):
        rc = _normalize_router_category_slug(raw_route.get("category"))
        if rc:
            meta["router_category"] = rc

    if not raw_route.get("success"):
        fb_objs = _fallback_tool_objs(by_name, max_pick, meta, "route_intent_unsuccessful")
        if fb_objs:
            logger.info("agent_chat: using fallback tool schemas after unsuccessful route-intent response")
            return await _bridge_fetch_tool_schemas(
                settings,
                fb_objs,
                timeout_seconds=settings.agent_timeout_seconds,
                meta=meta,
                router_reply=None,
                intent="operational",
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
        fb_objs = _fallback_tool_objs(by_name, max_pick, meta, "router_empty_tool_names")
        if fb_objs:
            tools_objs = fb_objs
    if not tools_objs:
        return RouterTurnResult("operational", None, reply, meta)

    return await _bridge_fetch_tool_schemas(
        settings,
        tools_objs,
        timeout_seconds=settings.agent_timeout_seconds,
        meta=meta,
        router_reply=reply,
        intent=intent,
    )


async def maybe_upgrade_router_result_for_llm(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    rows: list[dict[str, Any]],
    user_message: str,
    explicit_tool_names: list[str] | None,
    rt: RouterTurnResult,
) -> RouterTurnResult:
    """Re-route or attach fallback schemas when the first router pass would stream the LLM without tool schemas."""
    if _looks_like_tool_pick_question(user_message):
        return rt
    explicit = bool(explicit_tool_names)
    is_explicit_run = bool(_EXPLICIT_RUN_TOOL_RE.search(user_message))
    is_contextual_follow_up = _looks_like_contextual_tool_follow_up(user_message, rows)
    conv_gap = (
        rt.intent == "conversational"
        and (
            not (rt.router_reply or "").strip()
            or is_explicit_run
            or is_contextual_follow_up
        )
        and (explicit or is_explicit_run or is_contextual_follow_up or session_suggests_security_follow_up(rows))
    )
    op_no_schema = rt.intent == "operational" and not rt.schemas
    if not (conv_gap or op_no_schema):
        return rt

    meta = dict(rt.meta or {})
    augmented = _augment_router_user_message(rows, user_message.strip())
    rt2 = await plan_router_turn(
        settings,
        db,
        organization_id=organization_id,
        user_message=augmented,
        explicit_tool_names=explicit_tool_names,
        rows=rows,
    )
    if rt2.intent == "operational" and rt2.schemas:
        meta.update(rt2.meta or {})
        meta["router_recovery"] = "augmented_user_message"
        return RouterTurnResult("operational", rt2.schemas, rt2.router_reply, meta)

    allow_catalog_fallback = (
        op_no_schema
        or explicit
        or is_explicit_run
        or _looks_like_short_tool_approval(user_message)
    )
    if not allow_catalog_fallback:
        meta["router_recovery"] = "skipped_fallback_not_action_like"
        return rt

    ctx = await _load_chat_tool_maps(settings, db, organization_id=organization_id)
    if ctx is None:
        meta["router_recovery"] = "failed_no_catalog"
        return RouterTurnResult(rt.intent, rt.schemas, rt.router_reply, meta)

    by_name, _ = ctx
    max_pick = max(1, settings.agent_router_max_tools)
    objs = _fallback_tool_objs(by_name, max_pick, meta, "schema_recovery_fallback")
    if not objs:
        meta["router_recovery"] = "fallback_no_matching_tools"
        return RouterTurnResult("operational", None, rt.router_reply, meta)

    merged = await _bridge_fetch_tool_schemas(
        settings,
        objs,
        timeout_seconds=settings.agent_timeout_seconds,
        meta=meta,
        router_reply=None,
        intent=rt.intent if rt.intent == "operational" else "operational",
    )
    mm = dict(merged.meta or {})
    mm["router_recovery"] = mm.get("router_recovery") or "fallback_fetch"
    return RouterTurnResult("operational", merged.schemas, merged.router_reply, mm)


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
    batch_only_tool_names: frozenset[str] | None = None,
    batch_exclude_tool_names: frozenset[str] | None = None,
) -> AsyncIterator[str]:
    """
    Forward SSE from NyxStrike cipherstrike bridge and persist assistant message on completion.
    Supports TOOL_CALL_PENDING (single) and TOOL_CALL_BATCH_PENDING (multi-slot quorum batch).
    When auto_accept_tools is True (tenant admins only for execution), runs tools immediately
    instead of persisting pending / quorum rows — org-disabled tools stay blocked.
    Certain low-risk tools (see AGENT_CHAT_TOOLS_SKIP_APPROVAL_PROMPT) also auto-run when the client
    mode is ask_permission (still subject to org disabled-tool policy).

    Progressive tokens require live chunks from the agent. Operational turns with tool schemas on
    non-Gemini backends use the bridge's blocking chat-then-chunk SSE path: expect little or no text
    until the model finishes, then replay in smaller SSE frames.
    """
    roles = list(tenant_roles or [])
    timeout = settings.agent_llm_stream_timeout_seconds
    assistant_chunks: list[str] = []
    thinking_chunks: list[str] = []
    seen_done = False
    actual_input_tokens = None
    actual_output_tokens = None

    path = "api/cipherstrike/llm-stream"
    body: dict[str, Any] = {"messages": llm_messages}
    if tool_schemas:
        body["schemas"] = tool_schemas

    buffer = ""
    tool_pending_persisted = False
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
                    except json.JSONDecodeError as _je:
                        logger.error(
                            "stream_cipherstrike_turn: malformed TOOL_CALL_BATCH_PENDING JSON: %s; payload=%r",
                            _je, rest[:200],
                        )
                        envelope = {}
                    calls = envelope.get("calls") if isinstance(envelope.get("calls"), list) else []
                    calls = filter_tool_batch_calls(
                        calls,
                        only_tool_names=batch_only_tool_names,
                        exclude_tool_names=batch_exclude_tool_names,
                    )
                    slots = []
                    lines: list[str] = []
                    for i, c in enumerate(calls):
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
                    if not slots:
                        skip_outer_yield = True
                        continue
                    batch_auto = auto_accept_tools or _agent_chat_all_slots_skip_approval_prompt(slots)
                    if batch_auto and slots:
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
                            tool_schemas=tool_schemas,
                            auto_accept_tools=auto_accept_tools,
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
                            llm_tool_schemas=tool_schemas,
                            input_tokens=actual_input_tokens,
                            output_tokens=actual_output_tokens,
                        )
                        tool_pending_persisted = True
                        thinking_chunks.clear()
                        assistant_chunks.clear()
                        out_payload = {"assistant_message_id": str(mid), "calls": calls}
                        block_to_yield = f"data: [TOOL_CALL_BATCH_PENDING] {json.dumps(out_payload)}\n"

                elif payload.startswith("[TOOL_CALL_PENDING]"):
                    rest = payload[len("[TOOL_CALL_PENDING]") :].strip()
                    try:
                        pending_data = json.loads(rest)
                    except json.JSONDecodeError as _je:
                        logger.error(
                            "stream_cipherstrike_turn: malformed TOOL_CALL_PENDING JSON: %s; payload=%r",
                            _je, rest[:200],
                        )
                        pending_data = {}
                    tool_name = str(pending_data.get("tool_name") or "")
                    args = pending_data.get("arguments") if isinstance(pending_data.get("arguments"), dict) else {}
                    endpoint = str(pending_data.get("endpoint") or "")
                    desc = str(pending_data.get("description") or "")
                    # Guard: bridge sent a pending event without a tool_name (data corruption).
                    if not tool_name.strip():
                        logger.error(
                            "stream_cipherstrike_turn: TOOL_CALL_PENDING with empty tool_name; payload=%r",
                            rest[:200],
                        )
                        skip_outer_yield = True
                        continue
                    single_auto = auto_accept_tools or _agent_chat_skip_tool_approval_prompt(tool_name)
                    logger.info(
                        "stream_cipherstrike_turn: [TOOL_CALL_PENDING] tool=%r args_keys=%s endpoint=%r auto_accept=%s skip_prompt=%s -> %s_path",
                        tool_name, list(args.keys()) if isinstance(args, dict) else None,
                        endpoint, auto_accept_tools,
                        _agent_chat_skip_tool_approval_prompt(tool_name),
                        "auto_execute" if single_auto and tool_name.strip() else "manual_approval",
                    )
                    if single_auto and tool_name.strip():
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
                            follow_tool_schemas=tool_schemas,
                            auto_accept_tools=auto_accept_tools,
                        ):
                            yield line
                        skip_outer_yield = True
                    else:
                        # Use a minimal content marker (not the imitable markdown format) so the
                        # LLM doesn't learn to emit "[Tool call requested: ...]" as plain text.
                        intent_text = f"_tool_call_pending:{tool_name}_"
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
                            llm_tool_schemas=tool_schemas,
                            input_tokens=actual_input_tokens,
                            output_tokens=actual_output_tokens,
                        )
                        tool_pending_persisted = True
                        thinking_chunks.clear()
                        assistant_chunks.clear()
                        pending_data["assistant_message_id"] = str(mid)
                        block_to_yield = f"data: [TOOL_CALL_PENDING] {json.dumps(pending_data)}\n"
                        logger.info(
                            "stream_cipherstrike_turn: persisted SINGLE pending message_id=%s tool=%r state=pending",
                            str(mid), tool_name,
                        )

                elif payload.startswith("[STATS]"):
                    rest = payload[len("[STATS]") :].strip()
                    try:
                        stats_data = json.loads(rest)
                        if isinstance(stats_data, dict):
                            usage = stats_data.get("usage")
                            if isinstance(usage, dict):
                                actual_input_tokens = int(usage.get("prompt_tokens") or usage.get("prompt_token_count") or 0)
                                actual_output_tokens = int(usage.get("completion_tokens") or usage.get("completion_token_count") or 0)
                            else:
                                p_count = stats_data.get("prompt_eval_count") or stats_data.get("prompt_token_count")
                                e_count = stats_data.get("eval_count") or stats_data.get("candidates_token_count")
                                if p_count is not None or e_count is not None:
                                    actual_input_tokens = int(p_count or 0)
                                    actual_output_tokens = int(e_count or 0)
                    except Exception:
                        logger.exception("stream_cipherstrike_turn: failed to parse STATS payload: %r", rest[:200])

                elif payload == "[DONE]":
                    seen_done = True
                    if not tool_pending_persisted:
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
                                input_tokens=actual_input_tokens,
                                output_tokens=actual_output_tokens,
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
                        input_tokens=actual_input_tokens,
                        output_tokens=actual_output_tokens,
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
                    input_tokens=actual_input_tokens,
                    output_tokens=actual_output_tokens,
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
    chat_tool_context: tuple[AsyncIOMotorDatabase, ObjectId, ObjectId, ObjectId] | None = None,
    enrichment_tool_name: str = "",
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
            "execution_log_tail": "ERROR: Tool endpoint is not allowed.",
            "execution_log_truncated": False,
            "progress_line": None,
        }
        return json.dumps(err_obj), meta, 403

    args = dict(args) if isinstance(args, dict) else {}
    tn = enrichment_tool_name.strip()
    if not tn and isinstance(progress_context, dict):
        tn = str(progress_context.get("tool_name") or "").strip()
    if chat_tool_context and tn == PENETRATION_REPORT_TOOL_NAME:
        db_ctx, organization_id, user_id, session_id = chat_tool_context
        args = await enrich_penetration_report_tool_args(
            settings,
            db_ctx,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            args=args,
        )

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
        await _strip_store_report_pdf_after_agent_json(
            result_obj,
            tool_name=tn,
            chat_tool_context=chat_tool_context,
            http_status=status_code,
        )
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
    execution_log_lines: deque[str] = deque(maxlen=_EXECUTION_LOG_TAIL_LINES)
    execution_log_truncated = [False]
    progress_line: str | None = None
    emit_times: list[float] = [0.0]

    async def emit_accumulated(*, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        if not force and (now - emit_times[0]) < 0.1:
            return
        emit_times[0] = now
        out_tail, out_trunc = _truncate_tool_log_tail(stdout_acc if stdout_acc else None)
        err_tail, err_trunc = _truncate_tool_log_tail(stderr_acc if stderr_acc else None)
        exec_tail = _execution_log_tail_from_lines(execution_log_lines)
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
                execution_log_tail=exec_tail,
                execution_log_truncated=execution_log_truncated[0],
                progress_line=progress_line,
            )
        )

    async def on_chunk(evt: dict[str, Any]) -> None:
        nonlocal stdout_acc, stderr_acc, progress_line
        t = evt.get("type")
        if t == "terminal":
            return
        if t == "stdout":
            stdout_acc += str(evt.get("text") or "")
            await emit_accumulated()
        elif t == "stderr":
            stderr_acc += str(evt.get("text") or "")
            await emit_accumulated()
        elif t == "log":
            _append_execution_log_lines(execution_log_lines, str(evt.get("text") or ""), execution_log_truncated)
            await emit_accumulated()
        elif t == "progress":
            progress_line = str(evt.get("text") or "").strip() or None
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
            "execution_log_tail": _execution_log_tail_from_lines(execution_log_lines),
            "execution_log_truncated": execution_log_truncated[0],
            "progress_line": progress_line,
        }
        return json.dumps({"error": str(exc)}), meta, 500

    try:
        result_obj = json.loads(content.decode("utf-8"))
    except Exception:
        raw = content.decode("utf-8", errors="replace")
        result_obj = {"http_status": status_code, "raw": raw}
    await _strip_store_report_pdf_after_agent_json(
        result_obj,
        tool_name=tn,
        chat_tool_context=chat_tool_context,
        http_status=status_code,
    )
    result_text = _prepare_agent_tool_result_for_llm(settings, result_obj, status_code)
    meta = _progress_from_completed_run(status_code, result_obj)
    live_exec_tail = _execution_log_tail_from_lines(execution_log_lines)
    if live_exec_tail:
        meta["execution_log_tail"] = live_exec_tail
        meta["execution_log_truncated"] = execution_log_truncated[0]
    meta["progress_line"] = progress_line
    return result_text, meta, status_code


async def _run_one_tool(
    settings: Settings,
    endpoint: str,
    args: dict[str, Any],
    *,
    chat_tool_context: tuple[AsyncIOMotorDatabase, ObjectId, ObjectId, ObjectId] | None = None,
    enrichment_tool_name: str = "",
) -> str:
    text, _meta, _status = await _run_one_tool_detailed(
        settings,
        endpoint,
        args,
        chat_tool_context=chat_tool_context,
        enrichment_tool_name=enrichment_tool_name,
    )
    return text


async def _session_attack_chain_sequential(
    db: AsyncIOMotorDatabase,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
) -> bool:
    """True when this chat session was started from Plan Attack Chain (ordered workflow_steps)."""
    sess = await get_session_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    if not sess:
        return False
    ac = sess.get("attack_chain")
    return isinstance(ac, dict) and bool(ac.get("sequential"))


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
    tool_schemas: list[dict[str, Any]] | None = None,
    auto_accept_tools: bool = False,
    routing: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """Persist executions for each slot (approve/reject/blocked), optionally patch batch parent row, stream LLM follow-up."""
    needs_exec = any(str(s.get("human_decision") or "").lower() == "approve" for s in slots)
    if needs_exec:
        approved_only = [
            s for s in slots if str(s.get("human_decision") or "").lower() == "approve"
        ]
        all_approved_safe = bool(approved_only) and all(
            _agent_chat_skip_tool_approval_prompt(str(s.get("tool_name") or "").strip())
            for s in approved_only
        )
        if "tenant_admin" not in (tenant_roles or []) and not all_approved_safe:
            yield "data: [ERROR] Tenant administrator role required to execute tools\n\n"
            yield "data: [DONE]\n\n"
            return

    from app.services.organization_tools import get_disabled_tool_names

    disabled = await get_disabled_tool_names(db, organization_id)

    resolved_follow_schemas: list[dict[str, Any]] | None = tool_schemas
    if resolved_follow_schemas is None and batch_message_id is not None:
        parent_doc = await get_message_owned(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            message_id=batch_message_id,
        )
        raw_ts = parent_doc.get("llm_tool_schemas") if parent_doc else None
        if isinstance(raw_ts, list):
            resolved_follow_schemas = [x for x in raw_ts if isinstance(x, dict)] or None

    sess_chain = await get_session_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    from app.services.agent_specialists import validate_specialist_tool_call

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
                    "execution_log_tail": None,
                    "execution_log_truncated": False,
                    "progress_line": None,
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
                    "execution_log_tail": None,
                    "execution_log_truncated": False,
                    "progress_line": None,
                },
            )
        elif d == "approve":
            args = row.get("arguments") if isinstance(row.get("arguments"), dict) else {}
            scope_err = validate_specialist_tool_call(sess_chain or {}, tn, args) if sess_chain else None
            if scope_err:
                ts = _utc_now_iso()
                row.update(
                    {
                        "run_status": "error",
                        "run_started_at": ts,
                        "run_finished_at": ts,
                        "stdout_tail": None,
                        "stderr_tail": scope_err,
                        "stdout_truncated": False,
                        "stderr_truncated": False,
                        "exit_code": None,
                        "http_status": 403,
                        "execution_log_tail": scope_err,
                        "execution_log_truncated": False,
                        "progress_line": None,
                    },
                )
            else:
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
                        "execution_log_tail": None,
                        "execution_log_truncated": False,
                        "progress_line": None,
                    },
                )
        working_slots.append(row)

    approve_to_run = [
        s
        for s in working_slots
        if str(s.get("human_decision") or "").lower() == "approve"
        and str(s.get("tool_name") or "").strip() not in disabled
        and str(s.get("run_status") or "") == "queued"
    ]
    approve_to_run.sort(key=lambda s: int(s.get("slot_index", 0)))
    sequential_tool_execution = await _session_attack_chain_sequential(
        db, organization_id, user_id, session_id
    )
    chain_step_at_start: int | None = None
    if _is_sequential_attack_chain(sess_chain):
        rows_start = await list_messages(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
        )
        chain_step_at_start = attack_chain_next_step_index(sess_chain or {}, rows_start)

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

        scope_err: str | None = None
        if sess_chain:
            from app.services.agent_specialists import validate_specialist_tool_call

            scope_err = validate_specialist_tool_call(sess_chain, tn, args)
        if scope_err:
            fin = _utc_now_iso()
            prog = {
                "run_status": "error",
                "stdout_tail": None,
                "stderr_tail": scope_err,
                "stdout_truncated": False,
                "stderr_truncated": False,
                "exit_code": None,
                "http_status": 403,
                "run_finished_at": fin,
                "execution_log_tail": scope_err,
                "execution_log_truncated": False,
                "progress_line": None,
            }
            result_text = json.dumps({"error": scope_err})
            await prog_q.put(("finished", idx, tn, result_text, prog))
            return

        async def emit_live(payload: dict[str, Any]) -> None:
            await prog_q.put(("stream_progress", idx, tn, payload))

        fin = _utc_now_iso()
        prog: dict[str, Any] = {
            "run_status": "error",
            "stdout_tail": None,
            "stderr_tail": "Tool execution interrupted before completion",
            "stdout_truncated": False,
            "stderr_truncated": False,
            "exit_code": None,
            "http_status": None,
            "run_finished_at": fin,
            "execution_log_tail": "ERROR: Tool execution interrupted before completion",
            "execution_log_truncated": False,
            "progress_line": None,
        }
        result_text = json.dumps({"error": "Tool execution interrupted before completion"})
        try:
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
                    chat_tool_context=(db, organization_id, user_id, session_id),
                    enrichment_tool_name=tn,
                )
            except Exception as exc:
                logger.exception("batch tool %s", tn)
                se_t, se_tr = _truncate_tool_log_tail(str(exc))
                fin_err = _utc_now_iso()
                prog = {
                    "run_status": "error",
                    "stdout_tail": None,
                    "stderr_tail": se_t,
                    "stdout_truncated": False,
                    "stderr_truncated": se_tr,
                    "exit_code": None,
                    "http_status": None,
                    "run_finished_at": fin_err,
                    "execution_log_tail": f"ERROR: {exc}",
                    "execution_log_truncated": False,
                    "progress_line": None,
                }
                result_text = json.dumps({"error": str(exc)})
        finally:
            await prog_q.put(("finished", idx, tn, result_text, prog))

    if sequential_tool_execution and len(approve_to_run) > 1:
        exec_batches: list[list[dict[str, Any]]] = [[s] for s in approve_to_run]
    else:
        exec_batches = [approve_to_run] if approve_to_run else []

    async def persist_working_if_batch() -> None:
        if batch_message_id is not None and batch_filter is not None:
            await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
                batch_filter,
                {"$set": {"tool_calls": working_slots, "batch_execution_state": "executing"}},
            )

    results_by_idx: dict[int, str] = {}

    for exec_chunk in exec_batches:
        exec_tasks = [asyncio.create_task(exec_approved(s)) for s in exec_chunk]
        pending_finish = len(exec_tasks)

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
                    "execution_log_tail": None,
                    "execution_log_truncated": False,
                    "progress_line": None,
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
                            execution_log_tail=None,
                            execution_log_truncated=False,
                            progress_line=None,
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
                    "execution_log_tail": body.get("execution_log_tail"),
                    "execution_log_truncated": bool(body.get("execution_log_truncated")),
                    "progress_line": body.get("progress_line"),
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
                            execution_log_tail=prog.get("execution_log_tail"),
                            execution_log_truncated=bool(prog.get("execution_log_truncated")),
                            progress_line=prog.get("progress_line"),
                        ),
                    )
                    await _sse_flush_tick()
                pending_finish -= 1

    def _working_row_for_slot_index(si: int) -> dict[str, Any]:
        return next(
            (s for i, s in enumerate(working_slots) if int(s.get("slot_index", i)) == int(si)),
            {},
        )

    # Each tuple: (call_id, tool_name, args, result_content). The call_id is deterministic
    # (derived from batch message id + slot_index) so the in-memory follow-up and any later
    # rebuild via build_llm_messages_from_history produce IDENTICAL tool_call_id linkage.
    batch_msg_id_str = str(batch_message_id) if batch_message_id is not None else _new_synthetic_call_id()
    completed_results: list[tuple[str, str, dict[str, Any], str]] = []
    updated_slots: list[dict[str, Any]] = []
    for slot in ordered:
        idx = int(slot.get("slot_index", 0))
        tn = str(slot.get("tool_name") or "")
        decision = str(slot.get("human_decision") or "").lower()
        args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}
        cur = _working_row_for_slot_index(idx)
        slot_call_id = f"{batch_msg_id_str}_{idx}"

        if decision == "reject":
            skip_txt = f"[Skipped **{tn}** — operator rejected]"
            await insert_message(
                db,
                organization_id=organization_id,
                user_id=user_id,
                session_id=session_id,
                role="tool",
                content=skip_txt,
                tool_name=tn,
            )
            completed_results.append((slot_call_id, tn, args, skip_txt))
            updated_slots.append({**cur, "execution_outcome": "rejected", "call_id": slot_call_id})
            continue

        if tn.strip() in disabled:
            err_txt = json.dumps({"error": "Tool disabled for organization"})
            await insert_message(
                db,
                organization_id=organization_id,
                user_id=user_id,
                session_id=session_id,
                role="tool",
                content=err_txt,
                tool_name=tn,
            )
            completed_results.append((slot_call_id, tn, args, err_txt))
            updated_slots.append({**cur, "execution_outcome": "blocked", "call_id": slot_call_id})
            continue

        result_text = results_by_idx.get(idx)
        if result_text is None:
            result_text = json.dumps({"error": "Tool did not return a result"})
        att = attachments_from_tool_result_json(result_text)
        # Tool result lives on the tool-role message (for LLM context) and inline on the slot
        # (for UI render). No duplicate assistant markdown message — that caused format imitation.
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="tool",
            content=result_text,
            tool_name=tn,
        )
        completed_results.append((slot_call_id, tn, args, result_text))
        eo = (
            "error"
            if str(cur.get("run_status") or "") == "error"
            else "completed"
        )
        slot_patch: dict[str, Any] = {
            **cur,
            "execution_outcome": eo,
            "result_text": result_text,
            "call_id": slot_call_id,
        }
        if att:
            slot_patch["attachments"] = att
        updated_slots.append(slot_patch)

    if batch_message_id is not None and batch_filter is not None:
        await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
            batch_filter,
            {"$set": {"batch_execution_state": "completed", "tool_calls": updated_slots}},
        )
        await touch_session(db, session_id)
        await recalculate_session_intelligence(
            settings,
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            use_ai=False,
        )

    if chain_step_at_start is not None and completed_results:
        successful = [
            s
            for s in updated_slots
            if str(s.get("execution_outcome") or "").lower() in ("completed", "done", "success")
        ]
        if successful:
            await advance_attack_chain_step(
                db,
                session_id,
                completed_step_index=chain_step_at_start,
            )

    # Strip ALL tools that just ran/were-rejected from follow-up schemas + nudge to summarize.
    ran_tool_names_lower = {
        str(s.get("tool_name") or "").strip().lower()
        for s in updated_slots
        if str(s.get("tool_name") or "").strip()
    }
    pruned_batch_follow_schemas: list[dict[str, Any]] | None = None
    if isinstance(resolved_follow_schemas, list):
        pruned_batch_follow_schemas = [
            s for s in resolved_follow_schemas
            if isinstance(s, dict)
            and str((s.get("function") or {}).get("name") or s.get("name") or "").strip().lower() not in ran_tool_names_lower
        ] or None
    completed_names = sorted(
        str(s.get("tool_name") or "").strip()
        for s in updated_slots
        if str(s.get("execution_outcome") or "").lower() in ("completed", "done", "success")
    )
    batch_remaining_names: list[str] = []
    if isinstance(pruned_batch_follow_schemas, list):
        batch_remaining_names = [
            str((s.get("function") or {}).get("name") or s.get("name") or "").strip()
            for s in pruned_batch_follow_schemas
            if isinstance(s, dict)
        ]
    batch_remaining_nudge = ""
    if batch_remaining_names:
        batch_remaining_nudge = (
            f" You still have these tools available: {', '.join(batch_remaining_names)}. "
            "If the user's ORIGINAL message requested actions that match any of these remaining tools "
            "(e.g. 'generate report', 'create pdf', 'penetration report', or running more scans/tools), "
            "you MUST call them NOW by emitting a tool_call in this SAME response. "
            "CRITICAL: You MUST write the summary of completed findings in your conversational text content "
            "AND emit the tool_calls for the remaining tools in the same response. Do not omit the summary."
        )
    batch_summarize_system = {
        "role": "system",
        "content": (
            f"The following tools just ran: {', '.join(completed_names) or '(see prior messages)'}. "
            "Their results are in the tool messages that follow. "
            "CRITICAL: You MUST write a clear, detailed summary of all findings from these completed tools in your text response. "
            "Do NOT output only tool calls. Group findings by tool, highlight notable vulnerabilities or open ports, "
            "and outline what was discovered. "
            "Do NOT re-call any of the tools that already ran in this batch. "
            "Do NOT ask whether the user wants to proceed or confirm — just act."
            + batch_remaining_nudge
        ),
    }
    # Build a single assistant turn with all the batch tool_calls, then one tool-role message
    # per result, each linked by tool_call_id. Call_ids are the deterministic per-slot IDs
    # persisted above, so a later turn rebuilt from Mongo produces identical linkage.
    assistant_tool_calls_block: list[dict[str, Any]] = []
    tool_result_messages: list[dict[str, Any]] = []
    for cid, tn, args_, result_content in completed_results:
        assistant_tool_calls_block.append(
            {
                "id": cid,
                "type": "function",
                "function": {"name": tn, "arguments": json.dumps(args_)},
            },
        )
        tool_result_messages.append(
            {"role": "tool", "tool_call_id": cid, "name": tn, "content": result_content},
        )
    batch_assistant_turn = (
        [{"role": "assistant", "content": "", "tool_calls": assistant_tool_calls_block}]
        if assistant_tool_calls_block
        else []
    )
    follow_llm = (
        list(snapshot)
        + [batch_summarize_system]
        + batch_assistant_turn
        + tool_result_messages
    )
    follow_batch_only: frozenset[str] | None = None
    sess_ac = await get_session_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    follow_schemas = pruned_batch_follow_schemas
    available_names = await fetch_runnable_tool_name_set(
        settings, db, organization_id=organization_id,
    )
    if isinstance(sess_ac, dict):
        fresh_rows = await list_messages(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
        )
        ac_system, follow_batch_only, ac_suffix = attack_chain_followup_context(
            sess_ac, fresh_rows, available_names=available_names,
        )
        for ac_msg in reversed(ac_system):
            follow_llm.insert(0, ac_msg)
        if ac_suffix:
            for msg in follow_llm:
                content = msg.get("content")
                if isinstance(content, str) and "The following tools just ran" in content:
                    msg["content"] = content + ac_suffix
                    break
    await inject_followup_skills(settings, follow_llm, routing)
    if isinstance(sess_ac, dict):
        follow_schemas, resolved_only = await resolve_attack_chain_follow_schemas(
            settings,
            db,
            organization_id=organization_id,
            sess=sess_ac,
            rows=fresh_rows,
            legacy_pruned=pruned_batch_follow_schemas,
            session_id=session_id,
        )
        if resolved_only is not None:
            follow_batch_only = resolved_only
    async for chunk in stream_follow_up_after_tool(
        settings,
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        llm_messages=follow_llm,
        carry_thinking=carry_thinking,
        tool_schemas=follow_schemas,
        tenant_roles=tenant_roles,
        auto_accept_tools=auto_accept_tools,
        batch_only_tool_names=follow_batch_only,
        batch_exclude_tool_names=frozenset(ran_tool_names_lower) if ran_tool_names_lower else None,
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
    follow_tool_schemas: list[dict[str, Any]] | None = None,
    auto_accept_tools: bool = False,
) -> AsyncIterator[str]:
    roles_l = list(tenant_roles or [])
    if "tenant_admin" not in roles_l and not _agent_chat_skip_tool_approval_prompt(tool_name):
        yield "data: [ERROR] Tenant administrator role required for automatic tool execution\n\n"
        yield "data: [DONE]\n\n"
        return

    chain_step_idx: int | None = None
    sess_pre = await get_session_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    if _is_sequential_attack_chain(sess_pre):
        pre_rows = await list_messages(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
        )
        chain_step_idx = attack_chain_next_step_index(sess_pre or {}, pre_rows)

    from app.services.agent_specialists import validate_specialist_tool_call

    scope_err = validate_specialist_tool_call(sess_pre or {}, tool_name, args) if sess_pre else None
    if scope_err:
        err_txt = json.dumps({"error": scope_err})
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="tool",
            content=err_txt,
            tool_name=tool_name,
        )
        yield f"data: [ERROR] {scope_err}\n\n"
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
            tool_name=tool_name,
        )
        follow_llm = list(snapshot) + assistant_and_tool_result_pair(tool_name, args, err_txt)
        async for chunk in stream_follow_up_after_tool(
            settings,
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            llm_messages=follow_llm,
            carry_thinking=carry_thinking,
            tool_schemas=follow_tool_schemas,
            tenant_roles=roles_l,
            auto_accept_tools=auto_accept_tools,
        ):
            yield chunk
        return

    try:
        result_text = await _run_one_tool(
            settings,
            endpoint,
            args,
            chat_tool_context=(db, organization_id, user_id, session_id),
            enrichment_tool_name=tool_name,
        )
    except Exception as exc:
        logger.exception("auto single tool %s", tool_name)
        result_text = json.dumps({"error": str(exc)})

    att = attachments_from_tool_result_json(result_text)
    # Persist a structured assistant message describing the auto-executed tool. The tool_call
    # field carries the full execution metadata for the UI; no imitable markdown in content.
    auto_tc: dict[str, Any] = {
        "state": "confirmed",
        "tool_name": tool_name,
        "arguments": args,
        "endpoint": endpoint,
        "description": "",
        "run_status": "done",
        "result_text": result_text,
    }
    auto_assistant_mid = await insert_message(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        role="assistant",
        content=f"_tool_call_completed:{tool_name}_",
        tool_call=auto_tc,
        attachments=att,
    )
    await insert_message(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        role="tool",
        content=result_text,
        tool_name=tool_name,
    )
    await recalculate_session_intelligence(
        settings,
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        use_ai=False,
    )
    if chain_step_idx is not None:
        await advance_attack_chain_step(
            db,
            session_id,
            completed_step_index=chain_step_idx,
        )

    # Strip the just-executed tool from follow-up schemas + nudge model to summarize.
    ran_tool_lower = tool_name.strip().lower()
    pruned_follow_schemas: list[dict[str, Any]] | None = None
    if isinstance(follow_tool_schemas, list):
        pruned_follow_schemas = [
            s for s in follow_tool_schemas
            if isinstance(s, dict)
            and str((s.get("function") or {}).get("name") or s.get("name") or "").strip().lower() != ran_tool_lower
        ] or None
    remaining_tool_names: list[str] = []
    if isinstance(pruned_follow_schemas, list):
        remaining_tool_names = [
            str((s.get("function") or {}).get("name") or s.get("name") or "").strip()
            for s in pruned_follow_schemas
            if isinstance(s, dict)
        ]
    remaining_tool_nudge = ""
    if remaining_tool_names:
        remaining_tool_nudge = (
            f" You still have these tools available: {', '.join(remaining_tool_names)}. "
            "If the user's ORIGINAL message requested actions that match any of these remaining tools "
            "(e.g. 'generate report', 'create pdf', 'penetration report', or running more scans/tools), "
            "you MUST call them NOW by emitting a tool_call in this SAME response. "
            "CRITICAL: You must write the summary of completed findings in your conversational text content "
            "AND emit the tool_calls for the remaining tools in the same response. Do not omit the summary."
        )
    summarize_system = {
        "role": "system",
        "content": (
            f"The {tool_name} tool just ran and its result is in the previous tool message. "
            "CRITICAL: You MUST write a clear, detailed summary of all findings from this completed tool in your text response. "
            "Do NOT output only tool calls. Detail what was discovered and highlight notable findings. "
            "Do NOT re-call the same tool with the same arguments. "
            "Do NOT ask whether the user wants to proceed or confirm — just act."
            + remaining_tool_nudge
        ),
    }
    follow_msgs = (
        list(snapshot)
        + [summarize_system]
        + assistant_and_tool_result_pair(tool_name, args, result_text, call_id=str(auto_assistant_mid))
    )
    sess_ac = await get_session_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    follow_batch_only: frozenset[str] | None = None
    follow_schemas = pruned_follow_schemas
    available_names = await fetch_runnable_tool_name_set(
        settings, db, organization_id=organization_id,
    )
    if isinstance(sess_ac, dict):
        fresh_rows = await list_messages(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
        )
        ac_system, follow_batch_only, ac_suffix = attack_chain_followup_context(
            sess_ac, fresh_rows, available_names=available_names,
        )
        for ac_msg in reversed(ac_system):
            follow_msgs.insert(0, ac_msg)
        if ac_suffix:
            summarize_system["content"] = summarize_system["content"] + ac_suffix
        follow_schemas, resolved_only = await resolve_attack_chain_follow_schemas(
            settings,
            db,
            organization_id=organization_id,
            sess=sess_ac,
            rows=fresh_rows,
            legacy_pruned=pruned_follow_schemas,
            session_id=session_id,
        )
        if resolved_only is not None:
            follow_batch_only = resolved_only
    async for chunk in stream_follow_up_after_tool(
        settings,
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        llm_messages=follow_msgs,
        carry_thinking=carry_thinking,
        tool_schemas=follow_schemas,
        tenant_roles=roles_l,
        auto_accept_tools=auto_accept_tools,
        batch_only_tool_names=follow_batch_only,
        batch_exclude_tool_names=frozenset({ran_tool_lower}),
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
        routing=msg.get("routing") if isinstance(msg.get("routing"), dict) else None,
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
    tool_schemas: list[dict[str, Any]] | None = None,
    tenant_roles: list[str] | None = None,
    auto_accept_tools: bool = False,
    routing: dict[str, Any] | None = None,
    batch_only_tool_names: frozenset[str] | None = None,
    batch_exclude_tool_names: frozenset[str] | None = None,
) -> AsyncIterator[str]:
    """Post-tool LLM stream; handles further tool calls like the primary agent stream."""
    roles = list(tenant_roles or [])
    if batch_only_tool_names and not tool_schemas:
        blocked = ", ".join(sorted(batch_only_tool_names))
        text = (
            f"Next planned attack-chain tool(s) ({blocked}) are not installed or disabled "
            "in this workspace. Install them on the agent host or enable them for your organization."
        )
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="assistant",
            content=text,
            routing=routing,
        )
        await recalculate_session_intelligence(
            settings,
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            use_ai=False,
        )
        for i in range(0, len(text), 96):
            yield f"data: {json.dumps(text[i:i + 96])}\n\n"
            await _sse_flush_tick()
        yield "data: [DONE]\n\n"
        return

    timeout = settings.agent_llm_stream_timeout_seconds
    body: dict[str, Any] = {"messages": llm_messages}
    if tool_schemas:
        body["schemas"] = tool_schemas
    if batch_only_tool_names:
        body["attack_chain_force_next_tool"] = True
    # Build a set of (tool_name, args_json) for tool results already in the snapshot — these
    # already ran in this turn chain. If the follow-up LLM tries to re-call any of them with
    # identical args, drop the call to break the loop instead of re-launching the tool.
    recent_tool_runs: set[tuple[str, str]] = set()
    for _m in llm_messages:
        if not isinstance(_m, dict):
            continue
        if str(_m.get("role") or "") != "tool":
            continue
        _tn = str(_m.get("name") or _m.get("tool_name") or "").strip().lower()
        if not _tn:
            continue
        # The args used for the call live on the preceding assistant message's tool_call/tool_calls,
        # but we lack that here; key on tool_name alone for the snapshot since identical-tool
        # back-to-back calls are the loop we're breaking. Args-aware dedup happens per pending event.
        recent_tool_runs.add((_tn, ""))
    assistant_chunks: list[str] = []
    thinking_chunks: list[str] = []
    if carry_thinking and str(carry_thinking).strip():
        thinking_chunks.append(str(carry_thinking).strip())
    buffer = ""
    seen_done = False
    tool_pending_persisted = False
    actual_input_tokens = None
    actual_output_tokens = None

    def _is_duplicate_tool_call(tn: str, args: dict[str, Any]) -> bool:
        key_name = (tn or "").strip().lower()
        if not key_name:
            return False
        # If this tool already ran in the conversation snapshot we're following up from,
        # treat the new call as a loop and suppress it.
        return (key_name, "") in recent_tool_runs

    async def _persist_partial_before_tool() -> None:
        full_text = "".join(assistant_chunks).strip()
        think_txt = "".join(thinking_chunks).strip() or None
        if not full_text and not think_txt:
            return
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="assistant",
            content=full_text or "(continuing with tool calls…)",
            thinking_content=think_txt,
            routing=routing,
            llm_tool_schemas=tool_schemas,
            input_tokens=actual_input_tokens,
            output_tokens=actual_output_tokens,
        )
        assistant_chunks.clear()
        thinking_chunks.clear()

    async def _persist_and_stream_fallback(reason: str) -> AsyncIterator[str]:
        text = _fallback_post_tool_summary(llm_messages, reason)
        await insert_message(
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            role="assistant",
            content=text,
            thinking_content="".join(thinking_chunks).strip() or None,
            routing=routing,
        )
        await recalculate_session_intelligence(
            settings,
            db,
            organization_id=organization_id,
            user_id=user_id,
            session_id=session_id,
            use_ai=False,
        )
        for i in range(0, len(text), 96):
            yield f"data: {json.dumps(text[i:i + 96])}\n\n"
            await _sse_flush_tick()
        yield "data: [DONE]\n\n"

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
                skip_outer_yield = False
                data_lines = [ln for ln in raw_event.split("\n") if ln.startswith("data: ")]
                payload = data_lines[0][6:].strip() if data_lines else ""

                if payload.startswith("[TOOL_CALL_BATCH_PENDING]"):
                    rest = payload[len("[TOOL_CALL_BATCH_PENDING]") :].strip()
                    try:
                        envelope = json.loads(rest)
                    except json.JSONDecodeError as _je:
                        logger.error(
                            "stream_follow_up_after_tool: malformed TOOL_CALL_BATCH_PENDING JSON: %s; payload=%r",
                            _je, rest[:200],
                        )
                        envelope = {}
                    calls = envelope.get("calls") if isinstance(envelope.get("calls"), list) else []
                    calls = filter_tool_batch_calls(
                        calls,
                        only_tool_names=batch_only_tool_names,
                        exclude_tool_names=batch_exclude_tool_names,
                    )
                    # Drop calls that duplicate tools already executed in this snapshot.
                    calls = [
                        c for c in calls
                        if isinstance(c, dict) and not _is_duplicate_tool_call(
                            str(c.get("tool_name") or ""),
                            c.get("arguments") if isinstance(c.get("arguments"), dict) else {},
                        )
                    ]
                    if not calls:
                        skip_outer_yield = True
                        continue
                    await _persist_partial_before_tool()
                    slots = []
                    for i, c in enumerate(calls):
                        if not isinstance(c, dict):
                            continue
                        slots.append(
                            {
                                "slot_index": i,
                                "human_decision": None,
                                "tool_name": str(c.get("tool_name") or ""),
                                "arguments": c.get("arguments")
                                if isinstance(c.get("arguments"), dict)
                                else {},
                                "endpoint": str(c.get("endpoint") or ""),
                                "description": str(c.get("description") or ""),
                            },
                        )
                    batch_auto = auto_accept_tools or _agent_chat_all_slots_skip_approval_prompt(slots)
                    if batch_auto and slots:
                        approve_slots = [{**s, "human_decision": "approve"} for s in slots]
                        carry_pre = "".join(thinking_chunks).strip() or None
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
                            carry_thinking=carry_pre,
                            tool_schemas=tool_schemas,
                            auto_accept_tools=auto_accept_tools,
                        ):
                            yield line
                        skip_outer_yield = True
                    else:
                        lines: list[str] = []
                        for slot in slots:
                            tn = slot["tool_name"]
                            args = slot["arguments"]
                            lines.append(f"- **{tn}** — `{json.dumps(args)}`")
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
                            llm_tool_schemas=tool_schemas,
                            input_tokens=actual_input_tokens,
                            output_tokens=actual_output_tokens,
                        )
                        tool_pending_persisted = True
                        thinking_chunks.clear()
                        assistant_chunks.clear()
                        out_payload = {"assistant_message_id": str(mid), "calls": calls}
                        raw_event = f"data: [TOOL_CALL_BATCH_PENDING] {json.dumps(out_payload)}"
                        skip_outer_yield = False

                elif payload.startswith("[TOOL_CALL_PENDING]"):
                    rest = payload[len("[TOOL_CALL_PENDING]") :].strip()
                    try:
                        pending_data = json.loads(rest)
                    except json.JSONDecodeError as _je:
                        logger.error(
                            "stream_follow_up_after_tool: malformed TOOL_CALL_PENDING JSON: %s; payload=%r",
                            _je, rest[:200],
                        )
                        pending_data = {}
                    tool_name = str(pending_data.get("tool_name") or "")
                    args = (
                        pending_data.get("arguments")
                        if isinstance(pending_data.get("arguments"), dict)
                        else {}
                    )
                    endpoint = str(pending_data.get("endpoint") or "")
                    desc = str(pending_data.get("description") or "")
                    _tn_lower = tool_name.strip().lower()
                    # Diagnostic: surface what the follow-up actually sees so we can confirm
                    # the suppression guards are reached.
                    logger.info(
                        "stream_follow_up_after_tool: pending event name=%r excluded_set=%s only_set=%s recent_runs=%s",
                        tool_name,
                        sorted(batch_exclude_tool_names) if batch_exclude_tool_names else None,
                        sorted(batch_only_tool_names) if batch_only_tool_names else None,
                        sorted(t for (t, _) in recent_tool_runs),
                    )
                    # Suppress excluded / non-allowed / duplicate calls BEFORE persisting any
                    # partial assistant text — otherwise we leave a stale "(continuing…)" message.
                    if batch_exclude_tool_names and _tn_lower in batch_exclude_tool_names:
                        logger.warning(
                            "stream_follow_up_after_tool: SUPPRESSING excluded tool call name=%r args=%s (operator previously ran/rejected)",
                            tool_name, args,
                        )
                        skip_outer_yield = True
                        continue
                    if batch_only_tool_names is not None and _tn_lower not in batch_only_tool_names:
                        logger.warning(
                            "stream_follow_up_after_tool: SUPPRESSING non-allowed tool call name=%r",
                            tool_name,
                        )
                        skip_outer_yield = True
                        continue
                    if _is_duplicate_tool_call(tool_name, args):
                        logger.warning(
                            "stream_follow_up_after_tool: SUPPRESSING duplicate tool call name=%r (already ran in this chain)",
                            tool_name,
                        )
                        skip_outer_yield = True
                        continue
                    await _persist_partial_before_tool()
                    single_auto = auto_accept_tools or _agent_chat_skip_tool_approval_prompt(tool_name)
                    if single_auto and tool_name.strip():
                        carry_pre = "".join(thinking_chunks).strip() or None
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
                            carry_thinking=carry_pre,
                            follow_tool_schemas=tool_schemas,
                            auto_accept_tools=auto_accept_tools,
                        ):
                            yield line
                        skip_outer_yield = True
                    else:
                        # Minimal content (not imitable markdown) — same reason as primary stream.
                        intent_text = f"_tool_call_pending:{tool_name}_"
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
                            llm_tool_schemas=tool_schemas,
                            input_tokens=actual_input_tokens,
                            output_tokens=actual_output_tokens,
                        )
                        tool_pending_persisted = True
                        thinking_chunks.clear()
                        assistant_chunks.clear()
                        pending_data["assistant_message_id"] = str(mid)
                        raw_event = f"data: [TOOL_CALL_PENDING] {json.dumps(pending_data)}"

                if payload == "[DONE]":
                    seen_done = True
                    if not tool_pending_persisted:
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
                                input_tokens=actual_input_tokens,
                                output_tokens=actual_output_tokens,
                            )
                            await recalculate_session_intelligence(
                                settings,
                                db,
                                organization_id=organization_id,
                                user_id=user_id,
                                session_id=session_id,
                                use_ai=True,
                            )
                elif payload.startswith("[STATS]"):
                    rest = payload[len("[STATS]") :].strip()
                    try:
                        stats_data = json.loads(rest)
                        if isinstance(stats_data, dict):
                            usage = stats_data.get("usage")
                            if isinstance(usage, dict):
                                actual_input_tokens = int(usage.get("prompt_tokens") or usage.get("prompt_token_count") or 0)
                                actual_output_tokens = int(usage.get("completion_tokens") or usage.get("completion_token_count") or 0)
                            else:
                                p_count = stats_data.get("prompt_eval_count") or stats_data.get("prompt_token_count")
                                e_count = stats_data.get("eval_count") or stats_data.get("candidates_token_count")
                                if p_count is not None or e_count is not None:
                                    actual_input_tokens = int(p_count or 0)
                                    actual_output_tokens = int(e_count or 0)
                    except Exception:
                        logger.exception("stream_follow_up_after_tool: failed to parse STATS payload: %r", rest[:200])
                elif payload.startswith("[ERROR]"):
                    seen_done = True
                    err_txt = payload[7:].lstrip()
                    async for fallback_chunk in _persist_and_stream_fallback(err_txt):
                        yield fallback_chunk
                    return
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
                    yield raw_event + "\n\n"

        if buffer.strip():
            yield buffer if buffer.endswith("\n\n") else buffer + "\n\n"

        if not seen_done and (assistant_chunks or thinking_chunks):
            if not tool_pending_persisted:
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
                        input_tokens=actual_input_tokens,
                        output_tokens=actual_output_tokens,
                    )
                    await recalculate_session_intelligence(
                        settings,
                        db,
                        organization_id=organization_id,
                        user_id=user_id,
                        session_id=session_id,
                        use_ai=True,
                    )
            yield "data: [DONE]\n\n"
        elif not seen_done:
            # Agent closed the stream without a terminal marker (misbehaving proxy, partial
            # generator, or legacy agent). Unblock the UI so it stops showing "Agent is working".
            yield "data: [DONE]\n\n"
    except AgentUnreachableError as e:
        async for fallback_chunk in _persist_and_stream_fallback(e.message):
            yield fallback_chunk
