"""Pre-built attack-chain plans (AI Recon / Profiling / Vuln / OSINT) proxied from NyxStrike agent."""

from __future__ import annotations

from typing import Any

from app.config import Settings
from app.services.agent_client import AgentUnreachableError, agent_post_json

ATTACK_CHAIN_PLANS: list[dict[str, Any]] = [
    {
        "id": "ai_recon",
        "title": "AI Recon",
        "badge": "AI Recon",
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


def attack_chain_system_note(steps: list[dict[str, Any]]) -> str:
    """LLM instruction mirroring NyxStrike session workflow_steps order."""
    lines = [
        "Attack chain pipeline — run tools strictly in this order (one tool call per assistant turn):",
    ]
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        tool = str(step.get("tool") or step.get("name") or "").strip()
        if not tool:
            continue
        deps = step.get("dependencies")
        dep_list = [str(d) for d in deps] if isinstance(deps, list) else []
        dep_suffix = f" (after {', '.join(dep_list)})" if dep_list else ""
        lines.append(f"{i + 1}. {tool}{dep_suffix}")
    lines.append(
        "Do not batch multiple tools in one response. Call exactly one tool, wait for its result, then continue."
    )
    return "\n".join(lines)


async def preview_attack_chain_plan(
    settings: Settings,
    plan_id: str,
    target: str,
) -> dict[str, Any]:
    """Fetch workflow steps from the agent for a named attack-chain plan."""
    meta = _plan_meta(plan_id)
    if not meta:
        return {"success": False, "error": f"Unknown plan: {plan_id}"}

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
        "tools": tools,
        "steps": steps,
    }
