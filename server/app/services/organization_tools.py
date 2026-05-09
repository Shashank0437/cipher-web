"""Organization-level tool denylist (opt-out) and execution audit log."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.constants import (
    MAX_TOOL_RUN_REQUEST_SNAPSHOT,
    MAX_TOOL_RUN_RESPONSE_RAW,
    MAX_TOOL_RUN_STDERR_STORE,
    MAX_TOOL_RUN_STDOUT_STORE,
    ORG_TOOL_POLICY_COLLECTION,
    TOOL_EXECUTION_LOG_COLLECTION,
)

logger = logging.getLogger(__name__)


def catalog_tool_names(catalog: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    raw_tools = catalog.get("tools")
    if not isinstance(raw_tools, list):
        return names
    for item in raw_tools:
        if not isinstance(item, dict):
            continue
        n = str(item.get("name") or "").strip()
        if n:
            names.add(n)
    return names


def _trunc_text(s: str, max_len: int) -> str:
    if len(s) <= max_len:
        return s
    return s[: max_len - 24] + "\n… [truncated] …"


async def get_disabled_tool_names(db: AsyncIOMotorDatabase, organization_id: ObjectId) -> set[str]:
    doc = await db[ORG_TOOL_POLICY_COLLECTION].find_one({"organization_id": organization_id})
    if not doc:
        return set()
    raw = doc.get("disabled_tool_names") or []
    if not isinstance(raw, list):
        return set()
    return {str(x).strip() for x in raw if str(x).strip()}


async def get_policy_doc(db: AsyncIOMotorDatabase, organization_id: ObjectId) -> dict[str, Any]:
    disabled = sorted(await get_disabled_tool_names(db, organization_id))
    return {"disabled_tool_names": disabled}


async def set_tool_enabled_for_org(
    db: AsyncIOMotorDatabase,
    organization_id: ObjectId,
    user_id: ObjectId,
    tool_name: str,
    *,
    enabled: bool,
    valid_names: set[str],
) -> None:
    tn = tool_name.strip()
    if not tn:
        raise ValueError("tool_name is required")
    if tn not in valid_names:
        raise ValueError("Unknown tool — not in agent catalog")

    now = datetime.now(UTC)

    if not enabled:
        # Do not combine $addToSet disabled_tool_names with $setOnInsert on the same field —
        # MongoDB raises WriteError code 40 ("conflict at 'disabled_tool_names'").
        await db[ORG_TOOL_POLICY_COLLECTION].update_one(
            {"organization_id": organization_id},
            {
                "$set": {"updated_at": now, "updated_by": user_id},
                "$addToSet": {"disabled_tool_names": tn},
            },
            upsert=True,
        )
    else:
        await db[ORG_TOOL_POLICY_COLLECTION].update_one(
            {"organization_id": organization_id},
            {"$pull": {"disabled_tool_names": tn}, "$set": {"updated_at": now, "updated_by": user_id}},
        )


def _snapshot_payload(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        raw = json.dumps(payload, default=str)
    except Exception:
        return {"_error": "non-serializable payload"}
    if len(raw) <= MAX_TOOL_RUN_REQUEST_SNAPSHOT:
        return dict(payload)
    return {"_truncated": True, "preview": _trunc_text(raw, MAX_TOOL_RUN_REQUEST_SNAPSHOT)}


def execution_log_document(
    organization_id: ObjectId,
    user_id: ObjectId,
    *,
    tool_name: str,
    endpoint: str,
    request_payload: dict[str, Any],
    agent_status_code: int,
    response_content: bytes,
    content_type: str,
) -> dict[str, Any]:
    ctype = (content_type or "").split(";")[0].strip().lower()
    stdout = ""
    stderr = ""
    return_code: int | None = None
    success: bool | None = None
    execution_time: float | None = None
    timestamp = ""
    raw_text = ""
    parsed_json: Any | None = None

    if ctype.startswith("application/json") or "json" in ctype:
        try:
            parsed_json = json.loads(response_content.decode("utf-8", errors="replace"))
            if isinstance(parsed_json, dict):
                stdout = _trunc_text(str(parsed_json.get("stdout", "") or ""), MAX_TOOL_RUN_STDOUT_STORE)
                stderr = _trunc_text(str(parsed_json.get("stderr", "") or ""), MAX_TOOL_RUN_STDERR_STORE)
                rc = parsed_json.get("return_code")
                if rc is not None:
                    try:
                        return_code = int(rc)
                    except (TypeError, ValueError):
                        return_code = None
                if "success" in parsed_json:
                    success = bool(parsed_json.get("success"))
                et = parsed_json.get("execution_time")
                if isinstance(et, (int, float)):
                    execution_time = float(et)
                elif isinstance(et, str):
                    try:
                        execution_time = float(et)
                    except ValueError:
                        execution_time = None
                ts = parsed_json.get("timestamp")
                if ts is not None:
                    timestamp = str(ts)
        except json.JSONDecodeError:
            raw_text = _trunc_text(response_content.decode("utf-8", errors="replace"), MAX_TOOL_RUN_RESPONSE_RAW)
    else:
        raw_text = _trunc_text(response_content.decode("utf-8", errors="replace"), MAX_TOOL_RUN_RESPONSE_RAW)

    # API-style tools (e.g. http-framework) return JSON without stdout/stderr keys; keep a viewable body.
    if (
        not raw_text
        and parsed_json is not None
        and not stdout.strip()
        and not stderr.strip()
    ):
        raw_text = _trunc_text(
            json.dumps(parsed_json, indent=2, default=str),
            MAX_TOOL_RUN_RESPONSE_RAW,
        )

    now = datetime.now(UTC)
    return {
        "organization_id": organization_id,
        "user_id": user_id,
        "tool_name": tool_name.strip(),
        "endpoint": endpoint,
        "request_payload_snapshot": _snapshot_payload(request_payload),
        "agent_status_code": agent_status_code,
        "stdout": stdout,
        "stderr": stderr,
        "return_code": return_code,
        "success": success,
        "execution_time": execution_time,
        "timestamp": timestamp,
        "response_raw_snippet": raw_text,
        "created_at": now,
    }


async def insert_execution_log(db: AsyncIOMotorDatabase, doc: dict[str, Any]) -> ObjectId:
    res = await db[TOOL_EXECUTION_LOG_COLLECTION].insert_one(doc)
    return res.inserted_id


async def count_execution_logs(
    db: AsyncIOMotorDatabase,
    organization_id: ObjectId,
    *,
    tool_name: str | None,
) -> int:
    q: dict[str, Any] = {"organization_id": organization_id}
    if tool_name:
        q["tool_name"] = tool_name.strip()
    return int(await db[TOOL_EXECUTION_LOG_COLLECTION].count_documents(q))


async def list_execution_logs(
    db: AsyncIOMotorDatabase,
    organization_id: ObjectId,
    *,
    tool_name: str | None,
    limit: int,
    skip: int = 0,
) -> list[dict[str, Any]]:
    lim = max(1, min(limit, 100))
    sk = max(0, skip)
    q: dict[str, Any] = {"organization_id": organization_id}
    if tool_name:
        q["tool_name"] = tool_name.strip()
    cursor = (
        db[TOOL_EXECUTION_LOG_COLLECTION]
        .find(q)
        .sort("created_at", -1)
        .skip(sk)
        .limit(lim)
    )
    out: list[dict[str, Any]] = []
    async for doc in cursor:
        out.append(doc)
    return out
