"""Derived session intelligence for agent chat scan threads."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from bson import ObjectId
    from motor.motor_asyncio import AsyncIOMotorDatabase
else:
    ObjectId = Any
    AsyncIOMotorDatabase = Any

from app.config import Settings
from app.constants import AGENT_CHAT_MESSAGES_COLLECTION, AGENT_CHAT_SESSIONS_COLLECTION
from app.services.agent_client import AgentUnreachableError, agent_post_json

logger = logging.getLogger(__name__)

SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO")
TERMINAL_SUCCESS = {"done", "completed", "success"}
TERMINAL_FAILURE = {"error", "failed", "timeout"}
RUNNING_STATUSES = {"queued", "running"}
MAX_EVIDENCE_CHARS = 1200
MAX_AI_CONTEXT_CHARS = 24000


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Any) -> str:
    if isinstance(dt, datetime):
        return dt.astimezone(timezone.utc).isoformat()
    s = str(dt or "").strip()
    return s


def parse_dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def normalize_text(value: Any, *, limit: int = MAX_EVIDENCE_CHARS) -> str:
    text = str(value or "")
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        return text[: limit - 1].rstrip() + "…"
    return text


def stable_id(*parts: str) -> str:
    raw = "|".join(normalize_text(p, limit=400).lower() for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def looks_successful(status: str, result_text: str = "") -> bool:
    rs = status.strip().lower()
    if rs in TERMINAL_SUCCESS:
        return True
    if rs in TERMINAL_FAILURE:
        return False
    if result_text.strip():
        try:
            obj = json.loads(result_text)
            if isinstance(obj, dict) and obj.get("error"):
                return False
        except Exception:
            pass
        return True
    return False


def finding_counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    counts = {s.lower(): 0 for s in SEVERITIES}
    for f in findings:
        sev = str(f.get("severity") or "INFO").upper()
        if sev not in SEVERITIES:
            sev = "INFO"
        counts[sev.lower()] += 1
    counts["total"] = sum(counts.values())
    return counts


def format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m"
    return f"{m}m {s:02d}s"


def merge_execution_windows(windows: Iterable[tuple[datetime, datetime]]) -> float:
    ordered = sorted((s, e) for s, e in windows if e >= s)
    if not ordered:
        return 0.0
    merged: list[tuple[datetime, datetime]] = []
    for start, end in ordered:
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
        elif end > merged[-1][1]:
            merged[-1] = (merged[-1][0], end)
    return sum((e - s).total_seconds() for s, e in merged)


def _target_values(args: dict[str, Any]) -> list[str]:
    keys = ("target", "url", "domain", "host", "ip", "cidr", "base_url", "endpoint")
    vals: list[str] = []
    for k in keys:
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            vals.append(v.strip())
    return vals


def _result_obj(result_text: str) -> Any:
    if not result_text.strip():
        return None
    try:
        return json.loads(result_text)
    except Exception:
        return None


def _evidence_from_slot(slot: dict[str, Any], tool_message: str = "") -> str:
    pieces: list[str] = []
    for key in ("result_text", "execution_log_tail", "stdout_tail", "stderr_tail"):
        val = slot.get(key)
        if isinstance(val, str) and val.strip():
            pieces.append(val)
    if tool_message.strip():
        pieces.append(tool_message)
    raw = "\n".join(pieces)
    return normalize_text(raw, limit=MAX_EVIDENCE_CHARS)


def _result_observation(slot: dict[str, Any], tool_name: str, target: str, seen_at: str) -> dict[str, Any] | None:
    evidence = _evidence_from_slot(slot)
    if not evidence:
        return None

    result_text = str(slot.get("result_text") or "")
    obj = _result_obj(result_text)
    severity = "INFO"
    name = f"{tool_name} result"
    details = "Tool produced security-relevant output for review."

    if isinstance(obj, dict):
        llm_summary = obj.get("_llm_summary")
        if isinstance(llm_summary, dict):
            stdout_lines = llm_summary.get("stdout_nonempty_lines")
            stderr_lines = llm_summary.get("stderr_nonempty_lines")
            if isinstance(stdout_lines, int) and stdout_lines > 0:
                details = f"{tool_name} returned {stdout_lines} output line(s)."
            elif isinstance(stderr_lines, int) and stderr_lines > 0:
                details = f"{tool_name} returned stderr diagnostics."
        if obj.get("error"):
            return None

    return {
        "id": stable_id(name, severity, target, tool_name, evidence[:250]),
        "name": name,
        "severity": severity,
        "details": details,
        "source_tool": tool_name,
        "affected_target": target,
        "evidence": evidence,
        "first_seen": seen_at,
    }


def _iter_tool_slots(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    slots: list[dict[str, Any]] = []
    for row in rows:
        row_created = iso(row.get("created_at"))
        tc = row.get("tool_call")
        if isinstance(tc, dict):
            slots.append({**tc, "_message_id": str(row.get("_id") or ""), "_message_created_at": row_created})
        tcs = row.get("tool_calls")
        if isinstance(tcs, list):
            for slot in tcs:
                if isinstance(slot, dict):
                    slots.append({**slot, "_message_id": str(row.get("_id") or ""), "_message_created_at": row_created})
    return slots


def derive_session_intelligence(
    session_doc: dict[str, Any],
    rows: list[dict[str, Any]],
    *,
    ai_payload: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    now = utc_now()
    slots = _iter_tool_slots(rows)
    executed = [
        s for s in slots
        if str(s.get("tool_name") or "").strip()
        and (
            str(s.get("result_text") or "").strip()
            or str(s.get("run_status") or "").lower() in RUNNING_STATUSES | TERMINAL_SUCCESS | TERMINAL_FAILURE
            or str(s.get("execution_outcome") or "").lower() in {"completed", "error", "blocked", "rejected"}
        )
    ]
    success_slots = [
        s for s in executed
        if looks_successful(str(s.get("run_status") or s.get("execution_outcome") or ""), str(s.get("result_text") or ""))
    ]
    if not success_slots:
        return None

    targets: list[str] = []
    tools_used: list[str] = []
    timeline: list[dict[str, str]] = []
    windows: list[tuple[datetime, datetime]] = []
    any_running = False
    any_failure = False

    for slot in executed:
        tool_name = str(slot.get("tool_name") or "").strip()
        if tool_name and tool_name not in tools_used:
            tools_used.append(tool_name)
        args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}
        for target in _target_values(args):
            if target not in targets:
                targets.append(target)

        start = parse_dt(slot.get("run_started_at"))
        finish = parse_dt(slot.get("run_finished_at"))
        status = str(slot.get("run_status") or slot.get("execution_outcome") or "").lower()
        if status in RUNNING_STATUSES:
            any_running = True
            finish_for_window = now
        else:
            finish_for_window = finish
        if start and finish_for_window:
            windows.append((start, finish_for_window))
        if status in TERMINAL_FAILURE or status == "error":
            any_failure = True

        ts = iso(start or slot.get("_message_created_at") or session_doc.get("created_at") or now)
        timeline.append(
            {
                "timestamp": ts,
                "type": "tool_execution",
                "title": f"{tool_name} execution {status or 'recorded'}",
                "details": normalize_text(json.dumps(args, sort_keys=True), limit=500),
            }
        )
        if finish:
            timeline.append(
                {
                    "timestamp": iso(finish),
                    "type": "tool_completed" if status not in TERMINAL_FAILURE else "tool_failed",
                    "title": f"{tool_name} {'completed' if status not in TERMINAL_FAILURE else 'failed'}",
                    "details": normalize_text(str(slot.get("execution_log_tail") or slot.get("stdout_tail") or ""), limit=500),
                }
            )

    assistant_summaries = [
        normalize_text(row.get("content"), limit=900)
        for row in rows
        if row.get("role") == "assistant"
        and normalize_text(row.get("content"), limit=900)
        and not str(row.get("content") or "").startswith("_tool_call_")
        and "Tool batch pending" not in str(row.get("content") or "")
    ]

    findings: list[dict[str, Any]] = []
    for slot in success_slots:
        tool_name = str(slot.get("tool_name") or "").strip()
        args = slot.get("arguments") if isinstance(slot.get("arguments"), dict) else {}
        target = (_target_values(args) or targets or ["unknown"])[0]
        seen_at = iso(parse_dt(slot.get("run_finished_at")) or parse_dt(slot.get("run_started_at")) or now)
        obs = _result_observation(slot, tool_name, target, seen_at)
        if obs:
            findings.append(obs)

    if ai_payload:
        ai_findings = ai_payload.get("findings")
        if isinstance(ai_findings, list):
            evidence_corpus = normalize_text(
                "\n".join(
                    [
                        str(s.get("result_text") or "")
                        + "\n"
                        + str(s.get("execution_log_tail") or "")
                        + "\n"
                        + str(s.get("stdout_tail") or "")
                        + "\n"
                        + "\n".join(assistant_summaries)
                        for s in success_slots
                    ]
                ),
                limit=200_000,
            ).lower()
            for raw in ai_findings:
                if not isinstance(raw, dict):
                    continue
                evidence = normalize_text(raw.get("evidence"), limit=MAX_EVIDENCE_CHARS)
                if not evidence or evidence.lower()[:120] not in evidence_corpus:
                    continue
                sev = str(raw.get("severity") or "INFO").upper()
                if sev not in SEVERITIES:
                    sev = "INFO"
                name = normalize_text(raw.get("name"), limit=160) or "Security finding"
                target = normalize_text(raw.get("affected_target"), limit=240) or (targets[0] if targets else "unknown")
                source_tool = normalize_text(raw.get("source_tool"), limit=80) or (tools_used[0] if tools_used else "unknown")
                finding = {
                    "id": stable_id(name, sev, target, source_tool, evidence[:250]),
                    "name": name,
                    "severity": sev,
                    "details": normalize_text(raw.get("details"), limit=600),
                    "source_tool": source_tool,
                    "affected_target": target,
                    "evidence": evidence,
                    "first_seen": normalize_text(raw.get("first_seen"), limit=80) or iso(now),
                }
                findings.append(finding)

    deduped: dict[str, dict[str, Any]] = {}
    for f in findings:
        deduped[str(f["id"])] = f
    findings = sorted(deduped.values(), key=lambda f: (SEVERITIES.index(str(f.get("severity") or "INFO")), f["name"]))

    ai_title = normalize_text((ai_payload or {}).get("title"), limit=80)
    ai_summary = normalize_text((ai_payload or {}).get("summary"), limit=500)
    primary_target = targets[0] if targets else "target"
    if ai_title:
        title = ai_title
    elif tools_used:
        stage = "External surface scan" if any(t.lower() in {"subfinder", "amass", "httpx", "nmap"} for t in tools_used) else "Security validation"
        title = f"{stage} — {primary_target}"
    else:
        title = str(session_doc.get("title") or "Security session")
    title = " ".join(title.split()[:8])

    if ai_summary:
        summary = ai_summary
    elif assistant_summaries:
        summary = assistant_summaries[-1]
    else:
        summary = f"{', '.join(tools_used) or 'Tooling'} produced {len(findings)} evidence-backed finding(s) for {primary_target}."

    status = "IN_PROGRESS" if any_running else "COMPLETED"
    if not any_running and any_failure and not success_slots:
        status = "FAILED"

    started_candidates = [
        parse_dt(s.get("run_started_at")) for s in executed
    ] + [parse_dt(session_doc.get("created_at"))]
    started = min([d for d in started_candidates if d is not None], default=now)
    finished_candidates = [parse_dt(s.get("run_finished_at")) for s in executed]
    completed_at = None if status == "IN_PROGRESS" else iso(max([d for d in finished_candidates if d is not None], default=now))

    attachments = []
    for slot in success_slots:
        raw_att = slot.get("attachments")
        if isinstance(raw_att, list):
            attachments.extend(a for a in raw_att if isinstance(a, dict))

    return {
        "session_id": str(session_doc.get("_id") or ""),
        "title": title,
        "status": status,
        "summary": summary,
        "average_time_to_breach": format_duration(merge_execution_windows(windows)),
        "average_time_to_breach_seconds": int(round(merge_execution_windows(windows))),
        "total_scans": 1,
        "findings_count": finding_counts(findings),
        "findings": findings,
        "tools_used": tools_used,
        "timeline": sorted(timeline, key=lambda e: e.get("timestamp") or ""),
        "targets": targets,
        "started_at": iso(started),
        "updated_at": iso(now),
        "completed_at": completed_at,
        "replay_metadata": {"available": False},
        "report_metadata": {
            "attachments": attachments,
            "available": bool(attachments),
        },
    }


def build_ai_context(session_doc: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    parts: list[str] = [f"Chat title: {session_doc.get('title') or ''}"]
    for row in rows[-80:]:
        role = str(row.get("role") or "")
        if role == "user":
            parts.append(f"USER: {normalize_text(row.get('content'), limit=800)}")
        elif role == "assistant":
            tc = row.get("tool_call")
            tcs = row.get("tool_calls")
            if isinstance(tc, dict):
                parts.append(f"ASSISTANT_TOOL_CALL: {json.dumps(tc, default=str)[:2500]}")
            elif isinstance(tcs, list):
                parts.append(f"ASSISTANT_TOOL_BATCH: {json.dumps(tcs, default=str)[:5000]}")
            else:
                parts.append(f"ASSISTANT: {normalize_text(row.get('content'), limit=1200)}")
        elif role == "tool":
            parts.append(f"TOOL {row.get('tool_name') or ''}: {normalize_text(row.get('content'), limit=2500)}")
    text = "\n\n".join(parts)
    if len(text) > MAX_AI_CONTEXT_CHARS:
        return text[-MAX_AI_CONTEXT_CHARS:]
    return text


async def extract_ai_intelligence(settings: Settings, session_doc: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    context = build_ai_context(session_doc, rows)
    prompt = (
        "You are a security session intelligence extractor. Return ONLY compact JSON with keys "
        "title, summary, findings. Findings must be evidence-backed and use severities "
        "CRITICAL,HIGH,MEDIUM,LOW,INFO. Do not invent vulnerabilities. If evidence is only scanner output "
        "or enumeration data, use INFO. Each finding object must contain name,severity,details,source_tool,"
        "affected_target,evidence,first_seen. The evidence value must be an exact short excerpt copied from "
        "the supplied context. Keep title professional and max 8 words.\n\nCONTEXT:\n"
        f"{context}"
    )
    try:
        resp = await agent_post_json(
            settings,
            "api/cipherstrike/llm-chat",
            {"messages": [{"role": "user", "content": prompt}]},
            timeout_seconds=min(float(getattr(settings, "agent_route_intent_timeout_seconds", 60.0)), 90.0),
        )
    except AgentUnreachableError:
        return None
    except Exception:
        logger.exception("session_intelligence: AI extraction failed")
        return None
    content = str(resp.get("content") or "").strip()
    if not content:
        return None
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE | re.DOTALL)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        logger.warning("session_intelligence: AI returned non-JSON content=%r", content[:300])
        return None
    return parsed if isinstance(parsed, dict) else None


async def recalculate_session_intelligence(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    use_ai: bool = True,
) -> dict[str, Any] | None:
    session_doc = await db[AGENT_CHAT_SESSIONS_COLLECTION].find_one(
        {"_id": session_id, "organization_id": organization_id, "user_id": user_id},
    )
    if not session_doc:
        return None
    rows = await (
        db[AGENT_CHAT_MESSAGES_COLLECTION]
        .find({"session_id": session_id, "organization_id": organization_id, "user_id": user_id})
        .sort("created_at", 1)
        .to_list(length=200)
    )
    ai_payload = await extract_ai_intelligence(settings, session_doc, rows) if use_ai else None
    intel = derive_session_intelligence(session_doc, rows, ai_payload=ai_payload)
    if intel is None:
        return None
    await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id, "organization_id": organization_id, "user_id": user_id},
        {"$set": {"session_intelligence": intel, "updated_at": utc_now()}},
    )
    return intel


async def list_session_intelligence(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    limit: int = 100,
) -> list[dict[str, Any]]:
    rows = await (
        db[AGENT_CHAT_SESSIONS_COLLECTION]
        .find(
            {
                "organization_id": organization_id,
                "user_id": user_id,
                "session_intelligence": {"$exists": True},
            },
        )
        .sort("session_intelligence.updated_at", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    return [r.get("session_intelligence") for r in rows if isinstance(r.get("session_intelligence"), dict)]
