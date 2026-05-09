import re
import secrets
from datetime import UTC, datetime

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase


def slugify_company(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "tenant"


async def unique_organization_slug(db: AsyncIOMotorDatabase, company_name: str) -> str:
    base = slugify_company(company_name)
    slug = base
    counter = 0
    while await db.organizations.find_one({"slug": slug}):
        counter += 1
        suffix = secrets.token_hex(3) if counter > 50 else str(counter)
        slug = f"{base}-{suffix}"
    return slug
