from motor.motor_asyncio import AsyncIOMotorDatabase

from app.constants import SSO_CONFIGS_COLLECTION


def extract_email_domain(email: str) -> str:
    """Return lowercase domain from email (e.g. user@ril.com -> ril.com)."""
    parts = email.lower().strip().rsplit("@", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return ""
    return parts[1]


def normalize_domain(domain: str) -> str:
    d = domain.lower().strip().lstrip("@")
    return d


async def lookup_sso_config(db: AsyncIOMotorDatabase, domain: str) -> dict | None:
    norm = normalize_domain(domain)
    if not norm:
        return None
    cfg = await db[SSO_CONFIGS_COLLECTION].find_one({"domain": norm, "enabled": True})
    return cfg


async def lookup_sso_config_for_email(db: AsyncIOMotorDatabase, email: str) -> dict | None:
    domain = extract_email_domain(email)
    if not domain:
        return None
    return await lookup_sso_config(db, domain)


def sso_discover_payload(cfg: dict | None) -> dict:
    if not cfg:
        return {
            "sso_available": False,
            "sso_required": False,
            "provider_display_name": "",
            "domain": "",
        }
    enforced = bool(cfg.get("enforced"))
    return {
        "sso_available": True,
        "sso_required": enforced,
        "provider_display_name": cfg.get("provider_display_name") or cfg.get("domain") or "",
        "domain": cfg.get("domain") or "",
    }
