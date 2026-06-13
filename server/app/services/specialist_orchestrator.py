"""Lightweight specialist orchestration helpers (phase → subagent mapping, prompt snippets)."""

from __future__ import annotations

from typing import Any

from app.services.agent_specialists import load_agent_markdown

# Phase → primary subagent markdown file (OpenCode naming)
_PHASE_SUBAGENTS: dict[str, dict[str, str]] = {
    "htb-ctf": {
        "RECON": "htb-recon.md",
        "ENUM": "htb-service-enum.md",
        "FOOTHOLD": "htb-foothold.md",
        "PRIVESC": "htb-privesc-linux.md",
        "FLAG": "htb-flag.md",
        "LOOT": "htb-loot.md",
    },
    "bugbounty": {
        "RECON": "bb-recon.md",
        "GATHER": "bb-osint.md",
        "TEST": "bb-web-specialist.md",
        "REPORT": "bb-report.md",
    },
    "recon": {
        "GATHER": "recon-domain.md",
        "ENUM": "recon-network.md",
        "ANALYZE": "recon-web.md",
        "REPORT": "recon-report.md",
    },
}


def resolve_active_subagent(agent_id: str, phase: str | None) -> str | None:
    phase_key = (phase or "").strip().upper()
    if not phase_key:
        return None
    mapping = _PHASE_SUBAGENTS.get(agent_id, {})
    filename = mapping.get(phase_key)
    if not filename:
        return None
    return filename.replace(".md", "")


def subagent_prompt_snippet(
    agent_id: str,
    phase: str | None,
    *,
    specialists_dir: str = "",
    max_chars: int = 6000,
) -> str:
    """Load the active phase subagent playbook for injection into the leader turn."""
    mapping = _PHASE_SUBAGENTS.get(agent_id, {})
    phase_key = (phase or "").strip().upper()
    filename = mapping.get(phase_key)
    if not filename:
        return ""
    body = load_agent_markdown(agent_id, filename, specialists_dir=specialists_dir) or ""
    if not body:
        return ""
    header = f"ACTIVE SUBAGENT ({filename.replace('.md', '')} — phase {phase_key}):\n"
    out = header + body
    if len(out) > max_chars:
        out = out[:max_chars] + "\n… (subagent prompt truncated)"
    return out


def enrich_specialist_agent_for_phase(sa: dict[str, Any]) -> dict[str, Any]:
    """Set active_subagent from current phase (caller may persist)."""
    out = dict(sa)
    agent_id = str(out.get("id") or "")
    phase = out.get("phase")
    if str(out.get("status") or "") == "running" and phase:
        out["active_subagent"] = resolve_active_subagent(agent_id, str(phase))
    return out
