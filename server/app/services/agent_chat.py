"""Mongo persistence + LLM snapshot builder for /workspace/agent-chat."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import Settings
from app.constants import AGENT_CHAT_MESSAGES_COLLECTION, AGENT_CHAT_SESSIONS_COLLECTION
from app.services.agent_client import (
    AgentUnreachableError,
    agent_path_not_allowed,
    agent_post_json,
    agent_post_sse_stream,
    fetch_agent_health_and_catalog,
    forward_agent_post_tool,
    normalize_agent_tool_path,
)

logger = logging.getLogger(__name__)

_MAX_AGENT_CHAT_THINKING_CHARS = 100_000


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

_TAIL_MESSAGES_WITH_SUMMARY = 36


def _is_conversational(message: str) -> bool:
    lower = message.lower().strip()
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
) -> ObjectId:
    doc: dict[str, Any] = {
        "organization_id": organization_id,
        "user_id": user_id,
        "session_id": session_id,
        "role": role,
        "content": content,
        "created_at": _utc_now(),
    }
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
        try:
            schema_resp = await agent_post_json(
                settings,
                "api/cipherstrike/schemas-from-tools",
                {"tools": tools_objs},
                timeout_seconds=settings.agent_timeout_seconds,
            )
        except AgentUnreachableError as e:
            logger.warning("agent_chat schemas unreachable: %s", e.message)
            return RouterTurnResult("operational", None, None, {**meta, "error": e.message})

        if not schema_resp.get("success"):
            return RouterTurnResult("operational", None, None, {**meta, "schemas_error": schema_resp})

        schemas = schema_resp.get("schemas")
        if not isinstance(schemas, list):
            schemas = []
        return RouterTurnResult("operational", schemas if schemas else None, None, meta)

    try:
        raw_route = await agent_post_json(
            settings,
            "api/cipherstrike/route-intent",
            {
                "message": user_message.strip(),
                "tools": router_catalog,
                "max_tool_names": settings.agent_router_max_tools,
            },
            timeout_seconds=settings.agent_timeout_seconds,
        )
    except AgentUnreachableError as e:
        logger.warning("agent_chat route-intent unreachable: %s", e.message)
        return RouterTurnResult("operational", None, None, {"success": False, "error": e.message})

    meta["route_intent"] = raw_route
    if not raw_route.get("success"):
        return RouterTurnResult("operational", None, None, meta)

    intent = str(raw_route.get("intent") or "conversational").lower().strip()
    reply = str(raw_route.get("reply") or "").strip() or None
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
        return RouterTurnResult("operational", None, reply, meta)

    try:
        schema_resp = await agent_post_json(
            settings,
            "api/cipherstrike/schemas-from-tools",
            {"tools": tools_objs},
            timeout_seconds=settings.agent_timeout_seconds,
        )
    except AgentUnreachableError as e:
        logger.warning("agent_chat schemas unreachable: %s", e.message)
        return RouterTurnResult("operational", None, None, {**meta, "error": e.message})

    if not schema_resp.get("success"):
        return RouterTurnResult("operational", None, None, {**meta, "schemas_error": schema_resp})

    schemas = schema_resp.get("schemas")
    if not isinstance(schemas, list):
        schemas = []
    return RouterTurnResult("operational", schemas if schemas else None, reply, meta)


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


async def _run_one_tool(
    settings: Settings,
    endpoint: str,
    args: dict[str, Any],
) -> str:
    ep = normalize_agent_tool_path(endpoint)
    if agent_path_not_allowed(ep):
        return json.dumps({"error": "Tool endpoint is not allowed."})
    status_code, content, _ctype = await forward_agent_post_tool(settings, ep, args)
    try:
        result_obj = json.loads(content.decode("utf-8"))
    except Exception:
        result_obj = {"http_status": status_code, "raw": content.decode("utf-8", errors="replace")[:4000]}
    result_text = json.dumps(result_obj, indent=2)
    if len(result_text) > 4000:
        result_text = result_text[:4000] + "\n… (truncated)"
    return result_text


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

    async def approved_runner(slot: dict[str, Any]) -> tuple[int, str | None]:
        idx = int(slot.get("slot_index", 0))
        tn = str(slot.get("tool_name") or "")
        if tn.strip() in disabled:
            return idx, None
        endpoint = str(slot.get("endpoint") or "")
        args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}
        try:
            text = await _run_one_tool(settings, endpoint, args)
            return idx, text
        except Exception as exc:
            logger.exception("batch tool %s", tn)
            return idx, json.dumps({"error": str(exc)})

    approve_slots = [s for s in ordered if str(s.get("human_decision") or "").lower() == "approve"]
    parallel_pairs = await asyncio.gather(*[approved_runner(s) for s in approve_slots])
    results_by_idx: dict[int, str] = {}
    for idx, txt in parallel_pairs:
        if txt is not None:
            results_by_idx[idx] = txt

    follow_tool_msgs: list[dict[str, str]] = []
    updated_slots: list[dict[str, Any]] = []
    for slot in ordered:
        idx = int(slot.get("slot_index", 0))
        tn = str(slot.get("tool_name") or "")
        decision = str(slot.get("human_decision") or "").lower()
        args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}

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
            updated_slots.append({**slot, "execution_outcome": "rejected"})
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
            updated_slots.append({**slot, "execution_outcome": "blocked"})
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
        updated_slots.append({**slot, "execution_outcome": "completed"})

    if batch_message_id is not None:
        await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
            {"_id": batch_message_id},
            {"$set": {"batch_execution_state": "completed", "tool_calls": updated_slots}},
        )

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
