"""Mongo-backed agent chat — proxies NyxStrike cipherstrike bridge."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response, StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.constants import AGENT_CHAT_MESSAGES_COLLECTION, AGENT_CHAT_SESSIONS_COLLECTION
from app.db import get_database
from app.dependencies.auth import require_auth_user
from app.schemas.agent_chat import (
    AgentChatAttachmentOut,
    AgentChatMessageOut,
    AgentChatOrgToolRow,
    AgentChatOrgToolsOut,
    AgentChatSendBody,
    AgentChatSessionCreate,
    AgentChatSessionOut,
    AgentChatSessionPatch,
    AgentChatToolConfirmBody,
    AgentChatToolDecisionsPatch,
)
from app.services.agent_chat import (
    RouterTurnResult,
    _EXPLICIT_RUN_TOOL_RE,
    _agent_chat_skip_tool_approval_prompt,
    _looks_like_contextual_tool_follow_up,
    assistant_and_tool_result_pair,
    message_references_pronoun_target,
    recent_target_from_rows,
    infer_retry_rejected_tool_names,
    looks_like_retry_rejected_tools,
    retry_rejected_tools_system_note,
    _session_tool_outcomes,
    attachments_from_tool_result_json,
    build_llm_messages_from_history,
    context_snippet,
    create_session,
    delete_session,
    get_agent_chat_attachment_owned,
    get_message_owned,
    get_session_owned,
    insert_message,
    list_agent_chat_org_tools_catalog,
    list_messages,
    list_sessions,
    maybe_refresh_conversation_summary,
    maybe_upgrade_router_result_for_llm,
    merge_tool_batch_decisions,
    plan_router_turn,
    rename_session,
    routing_hints_from_plan_meta,
    stream_cipherstrike_turn,
    stream_execute_tool_batch,
    stream_follow_up_after_tool,
    touch_session_ui_context,
    _run_one_tool_detailed,
    _slot_progress_payload,
    _sse_flush_tick,
    _sse_tool_batch_slot_progress,
    _truncate_tool_log_tail,
    _utc_now_iso,
)
from app.services.agent_client import (
    AgentUnreachableError,
    agent_path_not_allowed,
    normalize_agent_tool_path,
)
from app.services.organization_tools import get_disabled_tool_names

logger = logging.getLogger(__name__)

_SSE_KEEPALIVE_SECONDS = 15.0


async def _detached_sse(source: AsyncIterator[str]) -> AsyncIterator[str]:
    """Stream chunks to the browser while letting the producer finish after disconnect.

    Long tool runs must persist their terminal state and follow-up assistant message even
    when a browser, proxy, or tab drops the HTTP stream. This wrapper decouples the
    response consumer from the work producer: once started, the source iterator is
    drained to completion; if the client disconnects, later chunks are discarded but the
    DB writes inside the source still happen.
    """
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    active = True

    async def produce() -> None:
        nonlocal active
        try:
            async for chunk in source:
                if active:
                    queue.put_nowait(chunk)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("agent_chat detached SSE producer failed")
            if active:
                queue.put_nowait(f"data: [ERROR] {exc}\n\n")
        finally:
            if active:
                queue.put_nowait(None)

    asyncio.create_task(produce())

    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=_SSE_KEEPALIVE_SECONDS)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if item is None:
                return
            yield item
    finally:
        active = False


router = APIRouter(prefix="/workspace/agent-chat", tags=["agent-chat"])

_AGENT_CHAT_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _session_out(doc: dict) -> AgentChatSessionOut:
    return AgentChatSessionOut(
        id=str(doc["_id"]),
        title=str(doc.get("title") or "Chat"),
        created_at=doc["created_at"],
        updated_at=doc["updated_at"],
    )


def _message_out(doc: dict) -> AgentChatMessageOut:
    tc_list = doc.get("tool_calls")
    tool_calls_out = tc_list if isinstance(tc_list, list) else None
    def _f(key: str):
        v = doc.get(key)
        if isinstance(v, float):
            return v
        if isinstance(v, int):
            return float(v)
        return None

    att_raw = doc.get("attachments")
    att_out: list[AgentChatAttachmentOut] | None = None
    if isinstance(att_raw, list) and att_raw:
        cleaned: list[AgentChatAttachmentOut] = []
        for a in att_raw:
            if isinstance(a, dict) and a.get("id") and a.get("filename"):
                cleaned.append(
                    AgentChatAttachmentOut(
                        id=str(a["id"]),
                        filename=str(a["filename"]),
                        content_type=str(a.get("content_type") or "application/pdf"),
                    )
                )
        att_out = cleaned or None

    return AgentChatMessageOut(
        id=str(doc["_id"]),
        role=str(doc.get("role") or "user"),
        content=str(doc.get("content") or ""),
        created_at=doc["created_at"],
        tool_call=doc.get("tool_call") if isinstance(doc.get("tool_call"), dict) else None,
        tool_calls=tool_calls_out,
        batch_execution_state=str(doc["batch_execution_state"]) if doc.get("batch_execution_state") else None,
        thinking_content=str(doc["thinking_content"]) if doc.get("thinking_content") else None,
        router_category=str(doc["router_category"]).strip() if doc.get("router_category") else None,
        keyword_category=str(doc["keyword_category"]).strip() if doc.get("keyword_category") else None,
        keyword_confidence=_f("keyword_confidence"),
        attachments=att_out,
    )


def _oid(s: str) -> ObjectId:
    try:
        return ObjectId(s)
    except InvalidId as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid id") from e


@router.get("/org-tools", response_model=AgentChatOrgToolsOut)
async def agent_chat_org_tools(
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> AgentChatOrgToolsOut:
    settings = get_settings()
    rows = await list_agent_chat_org_tools_catalog(
        settings,
        db,
        organization_id=user["organization_id"],
    )
    if rows is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent catalog unreachable",
        )
    return AgentChatOrgToolsOut(tools=[AgentChatOrgToolRow(**r) for r in rows])


@router.post("/sessions", response_model=AgentChatSessionOut)
async def create_chat_session(
    body: AgentChatSessionCreate,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> AgentChatSessionOut:
    title = body.title.strip() or "New chat"
    doc = await create_session(
        db,
        organization_id=user["organization_id"],
        user_id=user["_id"],
        title=title,
    )
    return _session_out(doc)


@router.get("/sessions", response_model=list[AgentChatSessionOut])
async def list_chat_sessions(
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> list[AgentChatSessionOut]:
    rows = await list_sessions(db, organization_id=user["organization_id"], user_id=user["_id"])
    return [_session_out(d) for d in rows]


@router.patch("/sessions/{session_id}", response_model=AgentChatSessionOut)
async def patch_chat_session(
    session_id: str,
    body: AgentChatSessionPatch,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> AgentChatSessionOut:
    sid = _oid(session_id)
    ok = await rename_session(
        db,
        organization_id=user["organization_id"],
        user_id=user["_id"],
        session_id=sid,
        title=body.title,
    )
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")
    doc = await get_session_owned(db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid)
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")
    return _session_out(doc)


@router.delete("/sessions/{session_id}")
async def remove_chat_session(
    session_id: str,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, bool]:
    sid = _oid(session_id)
    ok = await delete_session(
        db,
        organization_id=user["organization_id"],
        user_id=user["_id"],
        session_id=sid,
    )
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")
    return {"success": True}


@router.get("/sessions/{session_id}/messages", response_model=list[AgentChatMessageOut])
async def get_messages(
    session_id: str,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> list[AgentChatMessageOut]:
    sid = _oid(session_id)
    sess = await get_session_owned(db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid)
    if not sess:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")
    rows = await list_messages(
        db,
        organization_id=user["organization_id"],
        user_id=user["_id"],
        session_id=sid,
    )
    return [_message_out(m) for m in rows]


@router.get("/sessions/{session_id}/attachments/{attachment_id}")
async def download_agent_chat_attachment(
    session_id: str,
    attachment_id: str,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    sid = _oid(session_id)
    aid = _oid(attachment_id)
    sess = await get_session_owned(
        db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid
    )
    if not sess:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")
    doc = await get_agent_chat_attachment_owned(
        db,
        organization_id=user["organization_id"],
        user_id=user["_id"],
        session_id=sid,
        attachment_id=aid,
    )
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    data = doc.get("data")
    if data is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Invalid attachment payload")
    payload = bytes(data) if not isinstance(data, bytes) else data
    fn = str(doc.get("filename") or "download.pdf")
    ct = str(doc.get("content_type") or "application/pdf")
    return Response(
        content=payload,
        media_type=ct,
        headers={"Content-Disposition": f'attachment; filename="{fn}"'},
    )


@router.post("/sessions/{session_id}/messages")
async def post_message_stream(
    session_id: str,
    body: AgentChatSendBody,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    settings = get_settings()
    sid = _oid(session_id)
    sess = await get_session_owned(db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid)
    if not sess:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")

    await insert_message(
        db,
        organization_id=user["organization_id"],
        user_id=user["_id"],
        session_id=sid,
        role="user",
        content=body.message.strip(),
    )

    ctx_dump = body.context.model_dump() if body.context else {}
    await touch_session_ui_context(db, sid, ctx_dump)

    if str(sess.get("title") or "").strip() in ("", "New chat"):
        auto = body.message.strip()[:50] + ("…" if len(body.message.strip()) > 50 else "")
        await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
            {"_id": sid},
            {"$set": {"title": auto}},
        )

    explicit_seen: set[str] = set()
    explicit_tools: list[str] = []
    for item in body.explicit_tool_names:
        n = str(item).strip()
        if not n or n in explicit_seen:
            continue
        explicit_seen.add(n)
        explicit_tools.append(n)

    async def gen():
        # Send bytes immediately so the browser/proxy leaves "pending (0 B)" before router + agent work.
        yield ": stream-open\n\n"
        try:
            rows = await list_messages(
                db,
                organization_id=user["organization_id"],
                user_id=user["_id"],
                session_id=sid,
            )
            await maybe_refresh_conversation_summary(
                settings,
                db,
                organization_id=user["organization_id"],
                user_id=user["_id"],
                session_id=sid,
                rows=rows,
            )
            sess_fresh = await get_session_owned(
                db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid
            )
            summary_raw = (sess_fresh or {}).get("conversation_summary")
            summary_str = str(summary_raw or "").strip() or None

            ctx = body.context.model_dump() if body.context else None
            user_msg = body.message.strip()
            explicit_for_turn = list(explicit_tools)
            retry_rejected = (
                infer_retry_rejected_tool_names(rows)
                if looks_like_retry_rejected_tools(user_msg, rows)
                else []
            )
            for tn in retry_rejected:
                if tn not in explicit_for_turn:
                    explicit_for_turn.append(tn)
            _, completed_tools = _session_tool_outcomes(rows)
            batch_exclude = frozenset(completed_tools) if completed_tools else None
            batch_only = frozenset(tn.lower() for tn in retry_rejected) if retry_rejected else None
            extra_system_parts: list[str] = []
            ctx_snip = context_snippet(ctx)
            if ctx_snip:
                extra_system_parts.append(ctx_snip)
            if retry_rejected:
                extra_system_parts.append(retry_rejected_tools_system_note(retry_rejected))
            llm_messages = build_llm_messages_from_history(
                settings,
                rows,
                extra_system="\n\n".join(extra_system_parts) if extra_system_parts else None,
                conversation_summary=summary_str,
            )

            explicit_arg = explicit_for_turn if explicit_for_turn else None

            # Short-circuit: pronoun reference (same/this/that/it/the target) WITHOUT a
            # resolvable target in the conversation history → ask the user to specify, do
            # NOT call the LLM (it will produce empty responses or hallucinate).
            if message_references_pronoun_target(user_msg) and not explicit_arg:
                _recent_target = recent_target_from_rows(rows, current_user_message=user_msg)
                if not _recent_target:
                    ask_text = (
                        "You used a pronoun like 'same' / 'this' / 'the target', but I don't see a target "
                        "in our recent conversation. Which target (URL, hostname, or IP) should I use?"
                    )
                    for i in range(0, len(ask_text), 72):
                        yield f"data: {json.dumps(ask_text[i:i + 72])}\n\n"
                        await asyncio.sleep(0)
                    await insert_message(
                        db,
                        organization_id=user["organization_id"],
                        user_id=user["_id"],
                        session_id=sid,
                        role="assistant",
                        content=ask_text,
                    )
                    yield "data: [DONE]\n\n"
                    return

            try:
                rt = await plan_router_turn(
                    settings,
                    db,
                    organization_id=user["organization_id"],
                    user_message=user_msg,
                    explicit_tool_names=explicit_arg,
                    rows=rows,
                )
            except Exception:
                logger.exception("plan_router_turn")
                rt = RouterTurnResult("operational", None, None, {})

            rt = await maybe_upgrade_router_result_for_llm(
                settings,
                db,
                organization_id=user["organization_id"],
                rows=rows,
                user_message=user_msg,
                explicit_tool_names=explicit_arg,
                rt=rt,
            )

            if (
                rt.intent == "conversational"
                and (rt.router_reply or "").strip()
                and not _looks_like_contextual_tool_follow_up(user_msg, rows)
                and not _EXPLICIT_RUN_TOOL_RE.search(user_msg)
            ):
                text = rt.router_reply.strip()
                step = 72
                for i in range(0, len(text), step):
                    chunk = text[i : i + step]
                    yield f"data: {json.dumps(chunk)}\n\n"
                    await asyncio.sleep(0)
                await insert_message(
                    db,
                    organization_id=user["organization_id"],
                    user_id=user["_id"],
                    session_id=sid,
                    role="assistant",
                    content=text,
                    routing=routing_hints_from_plan_meta(rt.meta),
                )
                yield "data: [DONE]\n\n"
                return

            tool_schemas = rt.schemas if (rt.intent == "operational" or rt.schemas) else None
            tenant_roles = list(user.get("roles") or [])
            auto_accept = body.tool_execution_mode == "auto_accept"
            async for chunk in stream_cipherstrike_turn(
                settings,
                llm_messages,
                tool_schemas if tool_schemas else None,
                db=db,
                organization_id=user["organization_id"],
                user_id=user["_id"],
                session_id=sid,
                tenant_roles=tenant_roles,
                auto_accept_tools=auto_accept,
                routing=routing_hints_from_plan_meta(rt.meta),
                batch_only_tool_names=batch_only,
                batch_exclude_tool_names=batch_exclude,
            ):
                yield chunk
        except AgentUnreachableError as e:
            yield f"data: [ERROR] {e.message}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(_detached_sse(gen()), media_type="text/event-stream", headers=_AGENT_CHAT_SSE_HEADERS)


@router.patch("/sessions/{session_id}/messages/{message_id}/tool-decisions")
async def patch_tool_batch_decisions(
    session_id: str,
    message_id: str,
    body: AgentChatToolDecisionsPatch,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, bool | int]:
    sid = _oid(session_id)
    mid = _oid(message_id)
    sess = await get_session_owned(db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid)
    if not sess:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")
    try:
        quorum_met, decided, total = await merge_tool_batch_decisions(
            db,
            organization_id=user["organization_id"],
            user_id=user["_id"],
            session_id=sid,
            message_id=mid,
            decisions=body.decisions,
        )
    except ValueError as e:
        detail = str(e)
        if detail == "message_not_found":
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Message not found") from e
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=detail) from e
    return {"quorum_met": quorum_met, "decided": decided, "total": total}


@router.post("/sessions/{session_id}/messages/{message_id}/tool-batch-execute")
async def post_tool_batch_execute_stream(
    session_id: str,
    message_id: str,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    settings = get_settings()
    sid = _oid(session_id)
    mid = _oid(message_id)
    sess = await get_session_owned(db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid)
    if not sess:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")

    roles = user.get("roles") or []

    async def gen():
        try:
            async for chunk in stream_execute_tool_batch(
                settings,
                db,
                organization_id=user["organization_id"],
                user_id=user["_id"],
                session_id=sid,
                message_id=mid,
                tenant_roles=list(roles) if isinstance(roles, list) else [],
            ):
                yield chunk
        except AgentUnreachableError as e:
            yield f"data: [ERROR] {e.message}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(_detached_sse(gen()), media_type="text/event-stream", headers=_AGENT_CHAT_SSE_HEADERS)


@router.post("/sessions/{session_id}/tool-confirm")
async def tool_confirm_stream(
    session_id: str,
    body: AgentChatToolConfirmBody,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    settings = get_settings()
    sid = _oid(session_id)
    aid = _oid(body.assistant_message_id)

    sess = await get_session_owned(db, organization_id=user["organization_id"], user_id=user["_id"], session_id=sid)
    if not sess:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Session not found")

    msg = await get_message_owned(
        db,
        organization_id=user["organization_id"],
        user_id=user["_id"],
        session_id=sid,
        message_id=aid,
    )
    if not msg or msg.get("role") != "assistant":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Assistant message not found")
    batch_slots = msg.get("tool_calls")
    if isinstance(batch_slots, list) and batch_slots:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="This message uses batch approval — use tool-decisions and tool-batch-execute",
        )
    tc = msg.get("tool_call")
    if not isinstance(tc, dict) or tc.get("state") != "pending":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="No pending tool call on this message")

    snapshot = msg.get("llm_messages_snapshot")
    if not isinstance(snapshot, list):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Missing LLM snapshot on pending message")

    tool_name = str(tc.get("tool_name") or "")
    endpoint = normalize_agent_tool_path(str(tc.get("endpoint") or ""))
    args = tc.get("arguments") if isinstance(tc.get("arguments"), dict) else {}

    raw_follow_ts = msg.get("llm_tool_schemas")
    follow_tool_schemas = raw_follow_ts if isinstance(raw_follow_ts, list) else None

    if body.approved:
        roles = user.get("roles") or []
        if "tenant_admin" not in roles and not _agent_chat_skip_tool_approval_prompt(tool_name):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="Tenant administrator role required to execute tools",
            )

    async def gen():
        try:
            if not body.approved:
                # Atomic rejection: only one transition from pending → rejected wins.
                claim_rej = await db[AGENT_CHAT_MESSAGES_COLLECTION].find_one_and_update(
                    {"_id": aid, "tool_call.state": "pending"},
                    {"$set": {"tool_call.state": "rejected"}},
                )
                if claim_rej is None:
                    yield "data: [ERROR] This tool call has already been decided.\n\n"
                    yield "data: [DONE]\n\n"
                    return
                cancel = f"The operator chose not to run {tool_name}."
                await insert_message(
                    db,
                    organization_id=user["organization_id"],
                    user_id=user["_id"],
                    session_id=sid,
                    role="tool",
                    content=cancel,
                    tool_name=tool_name,
                )
                # Strip the rejected tool from the follow-up schemas so the model literally
                # cannot re-request it; otherwise rejection → instant re-request loop.
                rejected_name_lower = tool_name.strip().lower()
                pruned_schemas: list[dict[str, Any]] | None = None
                if isinstance(follow_tool_schemas, list):
                    pruned_schemas = [
                        s for s in follow_tool_schemas
                        if isinstance(s, dict)
                        and str((s.get("function") or {}).get("name") or s.get("name") or "").strip().lower() != rejected_name_lower
                    ] or None
                # System note nudging the model to acknowledge the rejection and stop re-trying.
                reject_system = {
                    "role": "system",
                    "content": (
                        f"The operator rejected the {tool_name} tool call. "
                        "Do NOT re-request the same tool. Acknowledge the rejection briefly and "
                        "either suggest an alternative tool, ask the operator what they'd prefer, "
                        "or wait for further instructions."
                    ),
                }
                follow_msgs = (
                    list(snapshot)
                    + [reject_system]
                    + assistant_and_tool_result_pair(tool_name, args, cancel, call_id=str(aid))
                )
                async for chunk in stream_follow_up_after_tool(
                    settings,
                    db,
                    organization_id=user["organization_id"],
                    user_id=user["_id"],
                    session_id=sid,
                    llm_messages=follow_msgs,
                    tool_schemas=pruned_schemas,
                    batch_exclude_tool_names=frozenset({rejected_name_lower}),
                ):
                    yield chunk
                return

            disabled = await get_disabled_tool_names(db, user["organization_id"])
            if tool_name.strip() in disabled:
                yield "data: [ERROR] This tool is disabled for your organization.\n\n"
                yield "data: [DONE]\n\n"
                return

            if agent_path_not_allowed(endpoint):
                yield "data: [ERROR] Tool endpoint is not allowed.\n\n"
                yield "data: [DONE]\n\n"
                return

            # Same log tail / meta path as batch execute; stream [TOOL_BATCH_SLOT_PROGRESS] for UI (slot 0).
            # Atomic state transition: only one approval wins the race. If two requests arrive
            # concurrently (e.g. double-click), the loser sees no match and aborts cleanly.
            started_iso = _utc_now_iso()
            claim = await db[AGENT_CHAT_MESSAGES_COLLECTION].find_one_and_update(
                {
                    "_id": aid,
                    "tool_call.state": "pending",
                    "$or": [
                        {"tool_call.run_status": {"$in": [None, "", "queued"]}},
                        {"tool_call.run_status": {"$exists": False}},
                    ],
                },
                {
                    "$set": {
                        "tool_call.run_status": "running",
                        "tool_call.run_started_at": started_iso,
                        "tool_call.run_finished_at": None,
                        "tool_call.stdout_tail": None,
                        "tool_call.stderr_tail": None,
                        "tool_call.stdout_truncated": False,
                        "tool_call.stderr_truncated": False,
                        "tool_call.execution_log_tail": None,
                        "tool_call.execution_log_truncated": False,
                        "tool_call.progress_line": None,
                        "tool_call.exit_code": None,
                        "tool_call.http_status": None,
                    },
                },
            )
            if claim is None:
                yield "data: [ERROR] This tool call has already been approved or is no longer pending.\n\n"
                yield "data: [DONE]\n\n"
                return
            yield _sse_tool_batch_slot_progress(
                aid,
                _slot_progress_payload(
                    slot_index=0,
                    tool_name=tool_name,
                    run_status="running",
                    stdout_tail=None,
                    stderr_tail=None,
                    stdout_truncated=False,
                    stderr_truncated=False,
                    exit_code=None,
                    http_status=None,
                    started_at=started_iso,
                    finished_at=None,
                    execution_log_tail=None,
                    execution_log_truncated=False,
                    progress_line=None,
                ),
            )
            await _sse_flush_tick()

            prog_q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

            async def enqueue_progress(body: dict[str, Any]) -> None:
                await prog_q.put(body)

            async def run_tool() -> tuple[str, dict[str, Any], int]:
                return await _run_one_tool_detailed(
                    settings,
                    endpoint,
                    args,
                    emit_slot_progress=enqueue_progress,
                    progress_context={
                        "slot_index": 0,
                        "tool_name": tool_name,
                        "started_at": started_iso,
                    },
                    chat_tool_context=(db, user["organization_id"], user["_id"], sid),
                    enrichment_tool_name=tool_name,
                )

            exec_task = asyncio.create_task(run_tool())
            idle_rounds = 0
            try:
                while True:
                    try:
                        partial = await asyncio.wait_for(prog_q.get(), timeout=0.08)
                        idle_rounds = 0
                        yield _sse_tool_batch_slot_progress(aid, partial)
                        await _sse_flush_tick()
                    except asyncio.TimeoutError:
                        idle_rounds += 1
                        if exec_task.done() and idle_rounds >= 4:
                            break
                while True:
                    try:
                        partial = await asyncio.wait_for(prog_q.get(), timeout=0.02)
                        yield _sse_tool_batch_slot_progress(aid, partial)
                        await _sse_flush_tick()
                    except asyncio.TimeoutError:
                        break
                result_text, prog, _http_status = exec_task.result()
            except Exception as exc:
                logger.exception("tool_confirm_stream execute %s", tool_name)
                fin_iso = _utc_now_iso()
                se_tail, se_trunc = _truncate_tool_log_tail(str(exc))
                prog = {
                    "run_status": "error",
                    "stdout_tail": None,
                    "stderr_tail": se_tail,
                    "stdout_truncated": False,
                    "stderr_truncated": se_trunc,
                    "exit_code": None,
                    "http_status": None,
                    "run_finished_at": fin_iso,
                    "execution_log_tail": f"ERROR: {exc}",
                    "execution_log_truncated": False,
                    "progress_line": None,
                }
                result_text = json.dumps({"error": str(exc)})

            # Persist the tool result ONLY as a tool-role message (no duplicate assistant markdown).
            # The original assistant message (aid) carries the tool_call state + execution metadata
            # for the UI to render. Attachments derived from the result are stored on the assistant
            # message (aid) so the UI can show download links next to the tool card.
            att = attachments_from_tool_result_json(result_text)
            await insert_message(
                db,
                organization_id=user["organization_id"],
                user_id=user["_id"],
                session_id=sid,
                role="tool",
                content=result_text,
                tool_name=tool_name,
            )
            finished_iso = prog.get("run_finished_at") if isinstance(prog.get("run_finished_at"), str) else None
            tool_call_updates: dict[str, Any] = {
                "tool_call.state": "confirmed",
                "tool_call.run_status": str(prog.get("run_status") or "done"),
                "tool_call.stdout_tail": prog.get("stdout_tail"),
                "tool_call.stderr_tail": prog.get("stderr_tail"),
                "tool_call.stdout_truncated": bool(prog.get("stdout_truncated")),
                "tool_call.stderr_truncated": bool(prog.get("stderr_truncated")),
                "tool_call.execution_log_tail": prog.get("execution_log_tail"),
                "tool_call.execution_log_truncated": bool(prog.get("execution_log_truncated")),
                "tool_call.progress_line": prog.get("progress_line"),
                "tool_call.exit_code": prog.get("exit_code"),
                "tool_call.http_status": prog.get("http_status"),
                "tool_call.run_started_at": started_iso,
                "tool_call.run_finished_at": finished_iso,
                "tool_call.result_text": result_text,
            }
            if att:
                tool_call_updates["attachments"] = att
            await db[AGENT_CHAT_MESSAGES_COLLECTION].update_one(
                {"_id": aid},
                {"$set": tool_call_updates},
            )

            yield _sse_tool_batch_slot_progress(
                aid,
                _slot_progress_payload(
                    slot_index=0,
                    tool_name=tool_name,
                    run_status=str(prog.get("run_status") or "done"),
                    stdout_tail=prog.get("stdout_tail"),
                    stderr_tail=prog.get("stderr_tail"),
                    stdout_truncated=bool(prog.get("stdout_truncated")),
                    stderr_truncated=bool(prog.get("stderr_truncated")),
                    exit_code=prog.get("exit_code"),
                    http_status=prog.get("http_status"),
                    started_at=started_iso,
                    finished_at=finished_iso,
                    execution_log_tail=prog.get("execution_log_tail"),
                    execution_log_truncated=bool(prog.get("execution_log_truncated")),
                    progress_line=prog.get("progress_line"),
                ),
            )
            await _sse_flush_tick()

            # Strip the just-executed tool from follow-up schemas so the model can't
            # re-call it, and inject an explicit "summarize, don't re-call" nudge.
            ran_tool_lower = tool_name.strip().lower()
            pruned_follow_schemas: list[dict[str, Any]] | None = None
            if isinstance(follow_tool_schemas, list):
                pruned_follow_schemas = [
                    s for s in follow_tool_schemas
                    if isinstance(s, dict)
                    and str((s.get("function") or {}).get("name") or s.get("name") or "").strip().lower() != ran_tool_lower
                ] or None
            summarize_system = {
                "role": "system",
                "content": (
                    f"The {tool_name} tool just ran and its result is in the previous tool message. "
                    "Your job NOW is to summarize the findings in plain prose for the operator: "
                    "what was discovered, what stands out, and what (if anything) to do next. "
                    "Do NOT re-call the same tool with the same arguments. "
                    "If a different tool is genuinely needed, you may call it — otherwise, write a clear summary."
                ),
            }
            follow_msgs = (
                list(snapshot)
                + [summarize_system]
                + assistant_and_tool_result_pair(tool_name, args, result_text, call_id=str(aid))
            )
            async for chunk in stream_follow_up_after_tool(
                settings,
                db,
                organization_id=user["organization_id"],
                user_id=user["_id"],
                session_id=sid,
                llm_messages=follow_msgs,
                tool_schemas=pruned_follow_schemas,
                batch_exclude_tool_names=frozenset({ran_tool_lower}),
            ):
                yield chunk
        except AgentUnreachableError as e:
            yield f"data: [ERROR] {e.message}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(_detached_sse(gen()), media_type="text/event-stream", headers=_AGENT_CHAT_SSE_HEADERS)
