"""Pre-built and intelligent attack-chain plans proxied from NyxStrike agent."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import Settings
from app.constants import AGENT_CHAT_SESSIONS_COLLECTION
from app.services.agent_client import AgentUnreachableError, agent_post_json

INTELLIGENT_ATTACK_CHAIN_ID = "intelligent_attack_chain"

ATTACK_CHAIN_PLANS: list[dict[str, Any]] = [
    {
        "id": INTELLIGENT_ATTACK_CHAIN_ID,
        "title": "Intelligent Attack Chain",
        "badge": "Intelligence",
        "kind": "intelligent",
        "description": "AI-driven target profiling and customized attack chain generation.",
        "details": "Best for quick, adaptive assessments — tools chosen by the intelligence engine.",
        "modal_description": (
            "Leverages AI to analyze the target and generate a customized attack chain. "
            "Preview the planned steps before starting the agent session."
        ),
        "tools": [],
        "placeholder": "Target URL or domain (https://example.com)",
    },
    {
        "id": "ai_recon",
        "title": "AI Recon",
        "badge": "AI Recon",
        "kind": "fixed",
        "description": "Recon session pre-loaded with the recon pipeline, ready to run.",
        "details": "Builds a session with nmap, whois, dig, http-headers, and whatweb.",
        "modal_description": (
            "Pre-loaded with the recon pipeline: nmap, whois, dig, http-headers, and whatweb — "
            "configured for your target."
        ),
        "tools": ["nmap", "whois", "dig", "http-headers", "whatweb", "nikto"],
        "placeholder": "Domain or IP (example.com / 10.0.0.1)",
    },
    {
        "id": "ai_profiling",
        "title": "AI Profiling",
        "badge": "AI Profiling",
        "kind": "fixed",
        "description": "Target-aware profiling pipeline that adapts tools to the target type.",
        "details": "Adds subfinder and theharvester for domains; skips DNS tools for bare IPs.",
        "modal_description": (
            "Classifies your target (IP, URL, or domain) and builds an adaptive pipeline: "
            "nmap, whois, whatweb, http-headers, dig, subfinder, theharvester, gobuster, nikto."
        ),
        "tools": [
            "nmap",
            "whois",
            "whatweb",
            "http-headers",
            "dig",
            "subfinder",
            "theharvester",
            "gobuster",
            "nikto",
        ],
        "placeholder": "Domain, URL, or IP (example.com / 10.0.0.1)",
    },
    {
        "id": "ai_vuln",
        "title": "AI Vuln Scan",
        "badge": "AI Vuln",
        "kind": "fixed",
        "description": "Vulnerability scanning pipeline: nuclei, sqlmap, dalfox, and nikto.",
        "details": "Checks for CVEs, SQL injection, XSS, and common web misconfigurations.",
        "modal_description": (
            "Runs a focused vulnerability scan: nuclei (CVE templates), sqlmap (SQLi), "
            "dalfox (XSS), and nikto (misconfiguration)."
        ),
        "tools": ["nuclei", "sqlmap", "dalfox", "nikto"],
        "placeholder": "Target URL or domain (https://example.com)",
    },
    {
        "id": "ai_osint",
        "title": "AI OSINT",
        "badge": "AI OSINT",
        "kind": "fixed",
        "description": "Passive OSINT pipeline: subfinder, theharvester, gau, and waybackurls.",
        "details": "Domain targets only — no active scanning, no bare IPs.",
        "modal_description": (
            "Purely passive intelligence gathering: subfinder (subdomains), theharvester "
            "(emails & hosts), gau (archived URLs), and waybackurls."
        ),
        "tools": ["subfinder", "theharvester", "gau", "waybackurls"],
        "placeholder": "Domain only (example.com)",
    },
]

_PLAN_AGENT_PATHS: dict[str, str] = {
    "ai_recon": "api/intelligence/ai-recon-session",
    "ai_profiling": "api/intelligence/ai-profiling-session",
    "ai_vuln": "api/intelligence/ai-vuln-session",
    "ai_osint": "api/intelligence/ai-osint-session",
}

_INTELLIGENT_PREVIEW_PATH = "api/intelligence/preview-attack-chain"


def list_attack_chain_plans() -> list[dict[str, Any]]:
    return list(ATTACK_CHAIN_PLANS)


def _plan_meta(plan_id: str) -> dict[str, Any] | None:
    for p in ATTACK_CHAIN_PLANS:
        if p["id"] == plan_id:
            return p
    return None


def _tool_names_from_steps(steps: list[Any]) -> list[str]:
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


def _phase_label_for_step_index(phases: list[dict[str, Any]], step_index: int) -> str | None:
    for ph in phases:
        if not isinstance(ph, dict):
            continue
        indices = ph.get("step_indices")
        if isinstance(indices, list) and step_index in indices:
            return str(ph.get("label") or ph.get("phase") or "").strip() or None
    return None


def attack_chain_system_note(
    steps: list[dict[str, Any]],
    *,
    intelligent: bool = False,
    objective: str | None = None,
    operator_note: str | None = None,
    executive_summary: str | None = None,
    attack_paths: list[str] | None = None,
    phases: list[dict[str, Any]] | None = None,
    planner_source: str | None = None,
) -> str:
    """LLM instruction mirroring NyxStrike session workflow_steps order."""
    lines: list[str] = []
    if intelligent:
        obj = (objective or "comprehensive").strip()
        source = (planner_source or "").strip()
        source_note = ""
        if source == "llm_hybrid":
            source_note = " (AI-planned hybrid planner)"
        elif source == "heuristic":
            source_note = " (heuristic fallback planner)"
        lines.append(
            "Intelligent attack chain (AI target profiling + planner)"
            f"{source_note}. "
            f"Precision objective: {obj}. "
            "Execute tools strictly in the planned order below — one tool call per assistant turn."
        )
    else:
        lines.append(
            "Attack chain pipeline — run tools strictly in this order (one tool call per assistant turn):"
        )

    summary = (executive_summary or "").strip()
    if summary:
        lines.append(f"Executive summary: {summary}")

    paths = [p.strip() for p in (attack_paths or []) if str(p).strip()]
    if paths:
        lines.append("Likely attack paths:")
        for p in paths[:3]:
            lines.append(f"- {p}")

    phase_list = phases if isinstance(phases, list) else []
    if phase_list:
        lines.append("Phased plan:")
        for ph in phase_list:
            if not isinstance(ph, dict):
                continue
            label = str(ph.get("label") or ph.get("phase") or "Phase").strip()
            indices = ph.get("step_indices")
            if isinstance(indices, list) and indices:
                tool_names = []
                for idx in indices:
                    if isinstance(idx, int) and 0 <= idx < len(steps):
                        step = steps[idx]
                        if isinstance(step, dict):
                            tn = str(step.get("tool") or "").strip()
                            if tn:
                                tool_names.append(tn)
                if tool_names:
                    lines.append(f"- {label}: {', '.join(tool_names)}")

    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        tool = str(step.get("tool") or step.get("name") or "").strip()
        if not tool:
            continue
        deps = step.get("dependencies")
        dep_list = [str(d) for d in deps] if isinstance(deps, list) else []
        dep_suffix = f" (after {', '.join(dep_list)})" if dep_list else ""
        phase_label = _phase_label_for_step_index(phase_list, i)
        phase_prefix = f"[{phase_label}] " if phase_label else ""
        lines.append(f"{i + 1}. {phase_prefix}{tool}{dep_suffix}")

    lines.append(
        "Do not batch multiple tools in one response. Call exactly one tool, wait for its result, then continue."
    )
    note = (operator_note or "").strip()
    if note:
        lines.append(f"Operator custom prompt: {note}")
    return "\n".join(lines)


def _parse_intelligent_preview(raw: dict[str, Any], target: str, objective: str) -> dict[str, Any]:
    attack_chain = raw.get("attack_chain") if isinstance(raw.get("attack_chain"), dict) else {}
    steps = attack_chain.get("steps")
    if not isinstance(steps, list):
        steps = []
    tools = _tool_names_from_steps(steps)
    profile = raw.get("target_profile") if isinstance(raw.get("target_profile"), dict) else None
    target_type = None
    if profile:
        target_type = str(profile.get("target_type") or profile.get("type") or "") or None

    executive_summary = str(raw.get("executive_summary") or "").strip() or None
    attack_paths_raw = raw.get("attack_paths")
    attack_paths: list[str] = []
    if isinstance(attack_paths_raw, list):
        attack_paths = [str(p).strip() for p in attack_paths_raw if str(p).strip()]

    attack_phases_raw = raw.get("attack_phases")
    attack_phases: list[dict[str, Any]] = []
    if isinstance(attack_phases_raw, list):
        attack_phases = [p for p in attack_phases_raw if isinstance(p, dict)]

    planner_source = str(raw.get("planner_source") or "").strip() or None

    return {
        "success": True,
        "plan_id": INTELLIGENT_ATTACK_CHAIN_ID,
        "session_name": "Intelligent Attack Chain",
        "target": str(raw.get("target") or target.strip()),
        "target_type": target_type,
        "objective": str(raw.get("objective") or objective),
        "tools": tools,
        "steps": steps,
        "risk_level": str(attack_chain.get("risk_level") or "unknown"),
        "estimated_time": int(attack_chain.get("estimated_time") or 0),
        "success_probability": float(attack_chain.get("success_probability") or 0),
        "target_profile": profile,
        "executive_summary": executive_summary,
        "attack_paths": attack_paths,
        "attack_phases": attack_phases,
        "planner_source": planner_source,
    }


def _completed_tools_from_rows(rows: list[dict[str, Any]], *, tail: int = 48) -> set[str]:
    completed: set[str] = set()
    for m in rows[-tail:]:
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
                if eo in ("done", "completed", "success") and hd != "reject":
                    completed.add(tn)
        content = str(m.get("content") or "")
        if m.get("role") == "tool" and m.get("tool_name"):
            completed.add(str(m.get("tool_name")).strip().lower())
        if "[Executed **" in content:
            for match in re.finditer(r"\[Executed \*\*([^*]+)\*\*", content):
                completed.add(match.group(1).strip().lower())
    return completed


def attack_chain_next_tool_only(
    sess: dict[str, Any],
    rows: list[dict[str, Any]],
) -> frozenset[str] | None:
    """Return frozenset of the next planned tool name for sequential attack-chain sessions."""
    ac = sess.get("attack_chain")
    if not isinstance(ac, dict) or not ac.get("sequential"):
        return None
    steps = ac.get("steps")
    if not isinstance(steps, list):
        return None
    completed = _completed_tools_from_rows(rows)
    for step in steps:
        if not isinstance(step, dict):
            continue
        tn = str(step.get("tool") or step.get("name") or "").strip().lower()
        if tn and tn not in completed:
            return frozenset({tn})
    return None


def attack_chain_execution_hint(
    sess: dict[str, Any],
    rows: list[dict[str, Any]],
) -> str | None:
    """Phase-aware hint for the next planned tool in an attack-chain session."""
    ac = sess.get("attack_chain")
    if not isinstance(ac, dict) or not ac.get("sequential"):
        return None
    steps = ac.get("steps")
    if not isinstance(steps, list) or not steps:
        return None

    phases = ac.get("phases")
    phase_list = phases if isinstance(phases, list) else []
    completed = _completed_tools_from_rows(rows)

    next_idx: int | None = None
    next_tool: str | None = None
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        tn = str(step.get("tool") or step.get("name") or "").strip()
        if tn and tn.lower() not in completed:
            next_idx = i
            next_tool = tn
            break

    if not next_tool:
        return "Attack chain plan: all planned tools have completed. Summarize findings; do not re-run completed tools."

    phase_label = _phase_label_for_step_index(phase_list, next_idx or 0)
    total = len([s for s in steps if isinstance(s, dict) and str(s.get("tool") or "").strip()])
    done = len(completed)
    phase_part = f"Current phase: {phase_label}. " if phase_label else ""
    return (
        f"Attack chain progress: {done}/{total} tools completed. "
        f"{phase_part}"
        f"Next planned step ({next_idx + 1}/{total}): `{next_tool}`. "
        "Call only this tool now — do not batch or skip ahead."
    )


async def preview_attack_chain_plan(
    settings: Settings,
    plan_id: str,
    target: str,
    *,
    objective: str = "comprehensive",
    operator_note: str = "",
) -> dict[str, Any]:
    """Fetch workflow steps from the agent for a named attack-chain plan."""
    meta = _plan_meta(plan_id)
    if not meta:
        return {"success": False, "error": f"Unknown plan: {plan_id}"}

    objective_key = (objective or "comprehensive").strip().lower()
    if objective_key not in ("quick", "comprehensive", "stealth"):
        objective_key = "comprehensive"

    if plan_id == INTELLIGENT_ATTACK_CHAIN_ID:
        payload: dict[str, Any] = {
            "target": target.strip(),
            "objective": objective_key,
            "use_llm_planner": True,
        }
        note = operator_note.strip()
        if note:
            payload["runtime_context"] = {"operator_note": note}
        try:
            raw = await agent_post_json(
                settings,
                _INTELLIGENT_PREVIEW_PATH,
                payload,
                timeout_seconds=max(settings.agent_timeout_seconds, 120),
            )
        except AgentUnreachableError as exc:
            return {"success": False, "error": exc.message}

        if not raw.get("success"):
            return {
                "success": False,
                "error": str(raw.get("error") or "Intelligent attack chain preview failed"),
            }
        return _parse_intelligent_preview(raw, target, objective_key)

    path = _PLAN_AGENT_PATHS.get(plan_id)
    if not path:
        return {"success": False, "error": f"No agent route for plan: {plan_id}"}

    try:
        raw = await agent_post_json(
            settings,
            path,
            {"target": target.strip()},
            timeout_seconds=settings.agent_timeout_seconds,
        )
    except AgentUnreachableError as exc:
        return {"success": False, "error": exc.message}

    if not raw.get("success"):
        return {
            "success": False,
            "error": str(raw.get("error") or "Agent plan request failed"),
        }

    steps = raw.get("steps")
    if not isinstance(steps, list):
        steps = []

    tools = _tool_names_from_steps(steps)
    if not tools:
        tools = list(meta.get("tools") or [])

    return {
        "success": True,
        "plan_id": plan_id,
        "session_name": str(raw.get("session_name") or meta["title"]),
        "target": str(raw.get("target") or target.strip()),
        "target_type": raw.get("target_type"),
        "objective": objective_key,
        "tools": tools,
        "steps": steps,
    }


def _reindex_phases(phases: list[dict[str, Any]], offset: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ph in phases:
        if not isinstance(ph, dict):
            continue
        raw_indices = ph.get("step_indices")
        if not isinstance(raw_indices, list):
            continue
        new_indices = [int(i) + offset for i in raw_indices if isinstance(i, int)]
        if not new_indices:
            continue
        out.append(
            {
                "phase": str(ph.get("phase") or "FOLLOWUP"),
                "label": str(ph.get("label") or "Follow-up"),
                "step_indices": new_indices,
            }
        )
    return out


def _followup_response_from_pending(
    session_id: str,
    pending: dict[str, Any],
    *,
    already_generated: bool = False,
) -> dict[str, Any]:
    steps = pending.get("steps") if isinstance(pending.get("steps"), list) else []
    tools = _tool_names_from_steps(steps)
    paths = pending.get("attack_paths")
    attack_paths = [str(p).strip() for p in paths if str(p).strip()] if isinstance(paths, list) else []
    phases = pending.get("attack_phases")
    attack_phases = [p for p in phases if isinstance(p, dict)] if isinstance(phases, list) else []
    return {
        "success": True,
        "session_id": session_id,
        "target": str(pending.get("target") or ""),
        "tools": tools,
        "steps": steps,
        "executive_summary": str(pending.get("executive_summary") or "") or None,
        "attack_paths": attack_paths,
        "attack_phases": attack_phases,
        "planner_source": str(pending.get("planner_source") or "") or None,
        "already_generated": already_generated,
        "message": str(pending.get("message") or "") or None,
    }


async def generate_attack_chain_followup(
    settings: Settings,
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
) -> dict[str, Any]:
    from app.services.agent_chat import get_session_owned, list_messages
    from app.services.session_intelligence import (
        build_ai_context,
        recalculate_session_intelligence,
    )

    sess = await get_session_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    if not sess:
        return {"success": False, "error": "Session not found"}

    ac = sess.get("attack_chain")
    if not isinstance(ac, dict) or not ac.get("sequential"):
        return {"success": False, "error": "Session is not an attack-chain run"}

    pending = ac.get("pending_followup")
    if isinstance(pending, dict) and isinstance(pending.get("steps"), list) and pending.get("steps"):
        return _followup_response_from_pending(str(session_id), pending, already_generated=True)

    rows = await list_messages(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    intel = await recalculate_session_intelligence(
        settings,
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
        use_ai=True,
    )
    if not intel:
        intel = sess.get("session_intelligence") if isinstance(sess.get("session_intelligence"), dict) else {}

    targets = intel.get("targets") if isinstance(intel.get("targets"), list) else []
    target = str(targets[0] if targets else "").strip()
    if not target:
        for step in ac.get("steps") or []:
            if isinstance(step, dict):
                params = step.get("parameters")
                if isinstance(params, dict):
                    for key in ("target", "url", "domain"):
                        val = str(params.get(key) or "").strip()
                        if val:
                            target = val
                            break
                if target:
                    break
    if not target:
        target = "unknown"

    tools_executed = list(intel.get("tools_used") or [])
    findings = list(intel.get("findings") or [])
    summary = str(intel.get("summary") or "")
    objective = str(ac.get("objective") or "comprehensive")
    operator_note = str(ac.get("operator_note") or "")
    risk_level = "HIGH" if int((intel.get("findings_count") or {}).get("critical") or 0) > 0 else (
        "MEDIUM" if int((intel.get("findings_count") or {}).get("high") or 0) > 0 else "LOW"
    )

    chat_context = build_ai_context(sess, rows)

    payload: dict[str, Any] = {
        "target": target,
        "objective": objective,
        "summary": summary,
        "risk_level": risk_level,
        "tools_executed": tools_executed,
        "findings": findings,
        "chat_context": chat_context,
        "operator_note": operator_note,
    }

    try:
        raw = await agent_post_json(
            settings,
            "api/intelligence/ai-followup-from-context",
            payload,
            timeout_seconds=max(settings.agent_timeout_seconds, 120),
        )
    except AgentUnreachableError as exc:
        return {"success": False, "error": exc.message}

    if not raw.get("success"):
        return {
            "success": False,
            "error": str(raw.get("error") or "Follow-up generation failed"),
        }

    steps = raw.get("workflow_steps")
    if not isinstance(steps, list):
        steps = []
    attack_phases = raw.get("attack_phases")
    if not isinstance(attack_phases, list):
        attack_phases = []

    exec_summary = str(raw.get("executive_summary") or "").strip()
    planner_source = str(raw.get("planner_source") or "llm")
    message = str(raw.get("message") or "").strip() or None

    pending_followup: dict[str, Any] = {
        "target": target,
        "steps": steps[:32],
        "executive_summary": exec_summary,
        "attack_phases": attack_phases[:16],
        "planner_source": planner_source,
        "attack_paths": [exec_summary[:200]] if exec_summary else [],
        "message": message,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id, "organization_id": organization_id, "user_id": user_id},
        {
            "$set": {
                "attack_chain.pending_followup": pending_followup,
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )

    return _followup_response_from_pending(str(session_id), pending_followup, already_generated=False)


async def append_attack_chain_followup(
    db: AsyncIOMotorDatabase,
    *,
    organization_id: ObjectId,
    user_id: ObjectId,
    session_id: ObjectId,
    steps: list[dict[str, Any]],
    executive_summary: str = "",
    attack_phases: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    from app.services.agent_chat import get_session_owned

    sess = await get_session_owned(
        db,
        organization_id=organization_id,
        user_id=user_id,
        session_id=session_id,
    )
    if not sess:
        return {"success": False, "error": "Session not found"}

    ac = sess.get("attack_chain")
    if not isinstance(ac, dict) or not ac.get("sequential"):
        return {"success": False, "error": "Session is not an attack-chain run"}

    existing_steps = ac.get("steps")
    if not isinstance(existing_steps, list):
        existing_steps = []

    new_steps = [s for s in steps if isinstance(s, dict)][:32]
    if not new_steps:
        return {"success": False, "error": "No follow-up steps to append"}

    offset = len(existing_steps)
    merged_steps = existing_steps + new_steps
    if len(merged_steps) > 48:
        merged_steps = merged_steps[:48]

    existing_phases = ac.get("phases")
    phase_list = list(existing_phases) if isinstance(existing_phases, list) else []
    new_phases = attack_phases if isinstance(attack_phases, list) else []
    reindexed = _reindex_phases(new_phases, offset)
    phase_list.extend(reindexed)

    chain_patch: dict[str, Any] = dict(ac)
    chain_patch["steps"] = merged_steps
    chain_patch["phases"] = phase_list[:32]
    if executive_summary.strip():
        chain_patch["followup_summary"] = executive_summary.strip()
    chain_patch["followup_applied_at"] = datetime.now(timezone.utc).isoformat()
    chain_patch.pop("pending_followup", None)

    await db[AGENT_CHAT_SESSIONS_COLLECTION].update_one(
        {"_id": session_id, "organization_id": organization_id, "user_id": user_id},
        {
            "$set": {
                "attack_chain": chain_patch,
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )

    return {"success": True, "attack_chain": chain_patch}
