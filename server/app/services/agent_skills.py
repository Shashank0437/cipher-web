"""Workflow skill injection for workspace agent-chat (no MCP required)."""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

from app.config import Settings
from app.services.agent_client import AgentUnreachableError, agent_get_json

logger = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_SKILL_MARKER_RE = re.compile(r"WORKFLOW SKILL \([^)]+\):")

# classify-task / route-intent category → skills/<slug>/SKILL.md folder name
_CATEGORY_TO_SKILL_SLUG: dict[str, str] = {
    "essential": "nmap-recon",
    "network_recon": "nmap-recon",
    "web_recon": "web-recon",
    "web_vuln": "web-vuln",
    "brute_force": "password-cracking",
    "osint": "subdomain-enum",
    "exploitation": "exploitation",
    "binary": "binary-analysis",
    "cloud": "cloud-audit",
    "active_directory": "smb-enum",
    "api": "web-vuln",
    "wifi_pentest": "nmap-recon",
    "database": "password-cracking",
    "vulnerability_intelligence": "exploitation",
    "reporting": "documentation",
}


def _normalize_category_slug(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    s = raw.strip().lower().replace(" ", "_").replace("-", "_")
    return s if s else None


def categories_from_router_meta(meta: dict[str, Any] | None) -> list[str]:
    """Unique categories from router + classify paths (router first)."""
    if not meta:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for key in ("router_category", "keyword_category"):
        norm = _normalize_category_slug(meta.get(key))
        if norm and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def slug_candidates_for_category(category: str) -> list[str]:
    """Ordered slug candidates: explicit map, hyphenated category, raw category folder."""
    candidates: list[str] = []
    seen: set[str] = set()

    def add(slug: str) -> None:
        s = (slug or "").strip()
        if s and s not in seen:
            seen.add(s)
            candidates.append(s)

    mapped = _CATEGORY_TO_SKILL_SLUG.get(category)
    if mapped:
        add(mapped)
    add(category.replace("_", "-"))
    if category != category.replace("_", "-"):
        add(category)
    return candidates


def skill_slugs_for_router_meta(meta: dict[str, Any] | None) -> list[str]:
    """Primary slug per unique category (for parallel fetch)."""
    slugs: list[str] = []
    seen: set[str] = set()
    for cat in categories_from_router_meta(meta):
        for cand in slug_candidates_for_category(cat):
            if cand not in seen:
                seen.add(cand)
                slugs.append(cand)
            break  # one primary candidate per category (first in ordered list)
    return slugs


def skill_slug_for_router_meta(meta: dict[str, Any] | None) -> str | None:
    slugs = skill_slugs_for_router_meta(meta)
    return slugs[0] if slugs else None


def _parse_frontmatter_body(text: str) -> str:
    m = _FRONTMATTER_RE.match(text)
    if m:
        return text[m.end():].strip()
    return text.strip()


def _load_local_skill(skills_dir: str, slug: str) -> str | None:
    root = Path(skills_dir).expanduser()
    skill_file = root / slug / "SKILL.md"
    if not skill_file.is_file():
        return None
    try:
        return _parse_frontmatter_body(skill_file.read_text(encoding="utf-8"))
    except OSError as exc:
        logger.warning("agent_skills: cannot read %s: %s", skill_file, exc)
        return None


async def _fetch_skill_from_agent(settings: Settings, slug: str) -> str | None:
    try:
        raw = await agent_get_json(
            settings,
            f"api/skills/{slug}",
            timeout_seconds=settings.agent_timeout_seconds,
        )
    except AgentUnreachableError as exc:
        logger.warning("agent_skills: agent unreachable for skill %r: %s", slug, exc.message)
        return None
    if not raw.get("success"):
        return None
    content = raw.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    return None


async def fetch_skill_body(settings: Settings, slug: str) -> str | None:
    local_dir = (settings.agent_chat_skills_dir or "").strip()
    if local_dir:
        body = _load_local_skill(local_dir, slug)
        if body:
            return body
    return await _fetch_skill_from_agent(settings, slug)


async def resolve_skill_for_category(settings: Settings, category: str) -> tuple[str, str] | None:
    """First existing SKILL.md among slug candidates for this category."""
    for slug in slug_candidates_for_category(category):
        body = await fetch_skill_body(settings, slug)
        if body:
            return slug, body
    return None


async def fetch_skill_blocks_for_meta(
    settings: Settings,
    meta: dict[str, Any] | None,
    *,
    intent: str,
) -> list[str]:
    """Load all skills for unique categories in meta (parallel per category)."""
    if not settings.agent_chat_skills_enabled or intent != "operational":
        return []
    categories = categories_from_router_meta(meta)
    if not categories:
        return []

    results = await asyncio.gather(
        *[resolve_skill_for_category(settings, cat) for cat in categories],
    )
    blocks: list[str] = []
    max_chars = settings.agent_chat_skill_max_chars
    for item in results:
        if not item:
            continue
        slug, body = item
        blocks.append(format_skill_system_message(slug, body, max_chars=max_chars))
    return blocks


def format_skill_system_message(slug: str, body: str, *, max_chars: int) -> str:
    trimmed = body.strip()
    if len(trimmed) > max_chars:
        trimmed = trimmed[:max_chars] + "\n… (skill truncated)"
    return (
        f"WORKFLOW SKILL ({slug}): Follow this playbook when choosing tools and sequencing scans. "
        "Use tool_calls to execute steps — do not only describe them.\n\n"
        + trimmed
    )


def llm_messages_already_have_skills(llm_messages: list[dict[str, Any]]) -> bool:
    for m in llm_messages:
        if str(m.get("role") or "") != "system":
            continue
        if _SKILL_MARKER_RE.search(str(m.get("content") or "")):
            return True
    return False


def inject_system_message_after_initial_block(
    llm_messages: list[dict[str, Any]],
    content: str,
) -> None:
    """Insert a system message after existing system rows (before user/assistant history)."""
    if not content.strip():
        return
    idx = 0
    while idx < len(llm_messages) and llm_messages[idx].get("role") == "system":
        idx += 1
    llm_messages.insert(idx, {"role": "system", "content": content.strip()})


def inject_skill_blocks_into_llm_messages(
    llm_messages: list[dict[str, Any]],
    blocks: list[str],
) -> int:
    if not blocks:
        return 0
    count = 0
    for block in blocks:
        if block.strip():
            inject_system_message_after_initial_block(llm_messages, block)
            count += 1
    return count


def router_meta_from_routing(routing: dict[str, Any] | None) -> dict[str, Any]:
    if not routing:
        return {}
    out: dict[str, Any] = {}
    rc = routing.get("router_category")
    if isinstance(rc, str) and rc.strip():
        out["router_category"] = rc.strip()
    kc = routing.get("keyword_category")
    if isinstance(kc, str) and kc.strip():
        out["keyword_category"] = kc.strip()
    kf = routing.get("keyword_confidence")
    if isinstance(kf, (int, float)):
        out["keyword_confidence"] = float(kf)
    return out


async def inject_skills_into_llm_messages(
    settings: Settings,
    llm_messages: list[dict[str, Any]],
    *,
    router_meta: dict[str, Any] | None,
    intent: str,
    prefetched_blocks: list[str] | None = None,
    skip_if_present: bool = True,
) -> list[str]:
    """Inject workflow skill system message(s). Returns injected slug list."""
    if not settings.agent_chat_skills_enabled or intent != "operational":
        return []
    if skip_if_present and llm_messages_already_have_skills(llm_messages):
        return []

    blocks = prefetched_blocks
    if blocks is None:
        blocks = await fetch_skill_blocks_for_meta(settings, router_meta, intent=intent)
    elif not blocks:
        return []

    injected_slugs: list[str] = []
    for block in blocks:
        m = re.search(r"WORKFLOW SKILL \(([^)]+)\):", block)
        if m:
            injected_slugs.append(m.group(1).strip())
    inject_skill_blocks_into_llm_messages(llm_messages, blocks)
    if injected_slugs:
        logger.info("agent_chat: injected skill(s) %s (%d blocks)", injected_slugs, len(blocks))
    return injected_slugs


async def inject_followup_skills(
    settings: Settings,
    llm_messages: list[dict[str, Any]],
    routing: dict[str, Any] | None,
) -> None:
    """Re-inject skills on tool follow-ups when snapshot lacks them (uses message routing meta)."""
    meta = router_meta_from_routing(routing)
    await inject_skills_into_llm_messages(
        settings,
        llm_messages,
        router_meta=meta,
        intent="operational",
        skip_if_present=True,
    )


async def maybe_inject_skill_into_llm_messages(
    settings: Settings,
    llm_messages: list[dict[str, Any]],
    *,
    router_meta: dict[str, Any] | None,
    intent: str,
) -> str | None:
    """Backward-compatible single-slug return for callers."""
    slugs = await inject_skills_into_llm_messages(
        settings,
        llm_messages,
        router_meta=router_meta,
        intent=intent,
        prefetched_blocks=router_meta.get("skill_injection_blocks") if router_meta else None,
    )
    return slugs[0] if slugs else None
