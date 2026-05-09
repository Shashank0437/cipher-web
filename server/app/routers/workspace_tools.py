from __future__ import annotations

import logging
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Response, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.db import get_database
from app.dependencies.tenant import require_tenant_admin
from app.schemas.workspace_tools import (
    KaliToolsSummary,
    ServerToolsSummary,
    ToolExecutionHistoryPage,
    ToolExecutionLogOut,
    WorkspaceServerStatus,
    WorkspaceToolCard,
    WorkspaceToolRunRequest,
    WorkspaceToolsOverview,
    WorkspaceToolsPayload,
)
from app.services.agent_client import (
    AgentUnreachableError,
    agent_path_not_allowed,
    fetch_agent_health_and_catalog,
    forward_agent_post_tool,
    normalize_agent_tool_path,
    post_refresh_tool_availability,
    tool_installed_from_agent_health,
)
from app.services.organization_tools import (
    count_execution_logs,
    execution_log_document,
    get_disabled_tool_names,
    insert_execution_log,
    list_execution_logs,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/workspace", tags=["workspace"])
api_tools_router = APIRouter(prefix="/api", tags=["workspace"])

SERVER_LAYER_CATEGORIES = frozenset({"intelligence", "ai_assist", "vulnerability_intelligence"})

# Session-derived actions invoked only from agent chat (not run from the workspace grid).
_WORKSPACE_TOOLS_EXCLUDE_FROM_GRID = frozenset({"penetration-report"})


def _coerce_param_payload(obj: object) -> dict[str, Any]:
    return obj if isinstance(obj, dict) else {}


def _server_layer_totals_from_cards(cards: list[WorkspaceToolCard]) -> ServerToolsSummary:
    srv = [t for t in cards if t.category in SERVER_LAYER_CATEGORIES]
    tot = len(srv)
    avail = sum(1 for t in srv if t.active)
    return ServerToolsSummary(available=avail, total=tot)


def _kali_totals_from_cards(cards: list[WorkspaceToolCard]) -> KaliToolsSummary:
    kali = [t for t in cards if t.category not in SERVER_LAYER_CATEGORIES]
    tot = len(kali)
    avail = sum(1 for t in kali if t.active)
    return KaliToolsSummary(available=avail, total=tot)


def _bars_from_effectiveness(active: bool, eff: float | None) -> int:
    if eff is not None and isinstance(eff, (int, float)):
        b = int(round(float(eff) * 5))
        b = max(1, min(5, b))
        if not active:
            return max(1, b - 2)
        return b
    return 5 if active else 1


def _build_cards(health: dict[str, Any], catalog: dict[str, Any]) -> list[WorkspaceToolCard]:
    raw_tools = catalog.get("tools")
    if not isinstance(raw_tools, list):
        raw_tools = []

    cards: list[WorkspaceToolCard] = []
    for item in raw_tools:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in _WORKSPACE_TOOLS_EXCLUDE_FROM_GRID:
            continue
        category = str(item.get("category") or "uncategorized")
        endpoint = str(item.get("endpoint") or "")
        method = str(item.get("method") or "POST")
        desc = str(item.get("desc") or "").strip() or f"Agent routing for `{name}`."
        long_desc = str(item.get("long_description") or "").strip()
        usage = str(item.get("usage") or "").strip()
        safety = str(item.get("safety") or "").strip()
        documentation_url = str(item.get("documentation_url") or "").strip()
        pdoc_raw = item.get("parameter_documentation")
        parameter_documentation = pdoc_raw if isinstance(pdoc_raw, dict) else {}
        eff = item.get("effectiveness")
        eff_f: float | None
        try:
            eff_f = float(eff) if eff is not None else None
        except (TypeError, ValueError):
            eff_f = None

        params_raw = _coerce_param_payload(item.get("params"))
        optional_raw = _coerce_param_payload(item.get("optional"))

        active = tool_installed_from_agent_health(health, item)

        cards.append(
            WorkspaceToolCard(
                name=name,
                description=desc,
                category=category,
                endpoint=endpoint,
                method=method,
                active=active,
                health_bars=_bars_from_effectiveness(active, eff_f),
                effectiveness=eff_f,
                params=params_raw,
                optional=optional_raw,
                long_description=long_desc,
                usage=usage,
                safety=safety,
                documentation_url=documentation_url,
                parameter_documentation=parameter_documentation,
            )
        )
    return cards


async def _workspace_tools_payload_for_org(db: AsyncIOMotorDatabase, organization_id: ObjectId) -> WorkspaceToolsPayload:
    settings = get_settings()
    try:
        health, catalog = await fetch_agent_health_and_catalog(settings)
    except AgentUnreachableError as e:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=e.message,
        ) from e

    disabled = await get_disabled_tool_names(db, organization_id)
    agent_status = health.get("status")
    agent_msg = health.get("message")
    overview_base = WorkspaceServerStatus(
        cipherstrike_api="ok",
        agent_reachable=True,
        agent_status=str(agent_status) if agent_status else None,
        agent_message=str(agent_msg) if agent_msg else None,
        agent_version=str(health["version"]) if health.get("version") else None,
        agent_uptime_seconds=float(health["uptime"]) if health.get("uptime") is not None else None,
    )

    all_cards = _build_cards(health, catalog)
    allowed = [c for c in all_cards if c.name not in disabled]
    blocked = [c for c in all_cards if c.name in disabled]

    kali = _kali_totals_from_cards(allowed)
    srv = _server_layer_totals_from_cards(allowed)
    overview = WorkspaceToolsOverview(
        server=overview_base,
        kali_tools=kali,
        server_tools=srv,
    )
    cat_set = {c.category for c in allowed}
    categories = sorted(cat_set)

    try:
        return WorkspaceToolsPayload(
            overview=overview,
            categories=categories,
            tools=sorted(allowed, key=lambda t: t.name),
            disabled_tools=sorted(blocked, key=lambda t: t.name),
        )
    except Exception:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent responses could not be normalized for workspace tools.",
        ) from None


@router.get("/tools", response_model=WorkspaceToolsPayload)
async def workspace_tools(
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> WorkspaceToolsPayload:
    return await _workspace_tools_payload_for_org(db, user["organization_id"])


@api_tools_router.get("/tools", response_model=WorkspaceToolsPayload)
async def workspace_tools_api_alias(
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> WorkspaceToolsPayload:
    return await _workspace_tools_payload_for_org(db, user["organization_id"])


def _tool_doc_to_out(doc: dict[str, Any]) -> ToolExecutionLogOut:
    snap = doc.get("request_payload_snapshot")
    if not isinstance(snap, dict):
        snap = {}
    return ToolExecutionLogOut(
        id=str(doc["_id"]),
        tool_name=str(doc.get("tool_name") or ""),
        created_at=doc["created_at"],
        agent_status_code=int(doc.get("agent_status_code") or 0),
        success=doc.get("success"),
        execution_time=float(doc["execution_time"]) if doc.get("execution_time") is not None else None,
        return_code=int(doc["return_code"]) if doc.get("return_code") is not None else None,
        stdout=str(doc.get("stdout") or ""),
        stderr=str(doc.get("stderr") or ""),
        endpoint=str(doc.get("endpoint") or ""),
        request_payload=snap,
        response_snippet=str(doc.get("response_raw_snippet") or ""),
    )


def _history_page_limit_offset(limit: int, offset: int) -> tuple[int, int]:
    lim = max(1, min(limit, 100))
    off = max(0, offset)
    return lim, off


@router.get("/tools/history", response_model=ToolExecutionHistoryPage)
async def workspace_tools_history(
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    tool: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> ToolExecutionHistoryPage:
    org_id = user["organization_id"]
    lim, off = _history_page_limit_offset(limit, offset)
    total = await count_execution_logs(db, org_id, tool_name=tool)
    rows = await list_execution_logs(
        db,
        org_id,
        tool_name=tool,
        limit=lim,
        skip=off,
    )
    return ToolExecutionHistoryPage(
        items=[_tool_doc_to_out(d) for d in rows],
        total=total,
        limit=lim,
        offset=off,
    )


@api_tools_router.get("/tools/history", response_model=ToolExecutionHistoryPage)
async def workspace_tools_history_api_alias(
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    tool: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> ToolExecutionHistoryPage:
    return await workspace_tools_history(user=user, db=db, tool=tool, limit=limit, offset=offset)


async def _persist_run_log_safe(
    db: AsyncIOMotorDatabase,
    organization_id: ObjectId,
    user_id: ObjectId,
    *,
    tool_name: str,
    endpoint: str,
    request_payload: dict[str, Any],
    status_code: int,
    content: bytes,
    content_type: str,
) -> None:
    doc = execution_log_document(
        organization_id,
        user_id,
        tool_name=tool_name,
        endpoint=endpoint,
        request_payload=request_payload,
        agent_status_code=status_code,
        response_content=content,
        content_type=content_type,
    )
    try:
        await insert_execution_log(db, doc)
    except Exception:
        logger.exception("tool_execution_log insert failed")


@router.post("/tools/run")
async def workspace_tool_run(
    body: WorkspaceToolRunRequest,
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> Response:
    settings = get_settings()
    org_id = user["organization_id"]
    uid = user["_id"]

    disabled = await get_disabled_tool_names(db, org_id)
    if body.tool_name.strip() in disabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="This tool is disabled for your organization")

    try:
        path = normalize_agent_tool_path(body.endpoint)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    if agent_path_not_allowed(path):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="Tool endpoint is not an allowed agent path",
        )
    try:
        status_code, content, content_type = await forward_agent_post_tool(
            settings,
            path,
            body.payload,
        )
    except AgentUnreachableError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=e.message) from e

    await _persist_run_log_safe(
        db,
        org_id,
        uid,
        tool_name=body.tool_name,
        endpoint=path,
        request_payload=body.payload,
        status_code=status_code,
        content=content,
        content_type=content_type,
    )

    if status_code >= 500:
        return Response(content=content, status_code=status.HTTP_502_BAD_GATEWAY, media_type=content_type)
    return Response(content=content, status_code=status_code, media_type=content_type)


@api_tools_router.post("/tools/run")
async def workspace_tool_run_api_alias(
    body: WorkspaceToolRunRequest,
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> Response:
    return await workspace_tool_run(body=body, user=user, db=db)


@router.post("/tools/availability/refresh")
async def workspace_tools_refresh_availability(
    user: dict = Depends(require_tenant_admin),
) -> dict[str, Any]:
    _ = user
    settings = get_settings()
    try:
        return await post_refresh_tool_availability(settings)
    except AgentUnreachableError as e:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=e.message,
        ) from e


@api_tools_router.post("/tools/availability/refresh")
async def workspace_tools_refresh_api_alias(
    user: dict = Depends(require_tenant_admin),
) -> dict[str, Any]:
    return await workspace_tools_refresh_availability(user=user)
