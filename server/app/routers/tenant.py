import logging
import secrets
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.constants import ORG_INVITE_REDIS_PREFIX
from app.db import get_database
from app.dependencies.tenant import require_tenant_admin
from app.redis_client import get_redis
from app.schemas.tenant import CreateInvitationIn, TenantMemberOut
from app.schemas.tenant_tools import OrgToolPolicyOut, PatchToolEnabledIn
from app.services.agent_client import AgentUnreachableError, fetch_agent_health_and_catalog
from app.services.brevo_email import render_invitation_email, send_transactional_email_one
from app.services.organization_tools import (
    catalog_tool_names,
    get_policy_doc,
    set_tool_enabled_for_org,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tenant", tags=["tenant"])


@router.get("/tools/policy", response_model=OrgToolPolicyOut)
async def get_org_tool_policy(
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> OrgToolPolicyOut:
    doc = await get_policy_doc(db, user["organization_id"])
    return OrgToolPolicyOut(disabled_tool_names=list(doc["disabled_tool_names"]))


@router.patch("/tools/policy", status_code=status.HTTP_200_OK)
async def patch_org_tool_policy(
    body: PatchToolEnabledIn,
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, str]:
    s = get_settings()
    try:
        _, catalog = await fetch_agent_health_and_catalog(s)
    except AgentUnreachableError as e:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=e.message,
        ) from e
    names = catalog_tool_names(catalog)
    try:
        await set_tool_enabled_for_org(
            db,
            user["organization_id"],
            user["_id"],
            body.tool_name,
            enabled=body.enabled,
            valid_names=names,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    return {"detail": "ok"}


PENDING = "pending"
ACCEPTED = "accepted"
CANCELLED = "cancelled"


@router.get("/members", response_model=list[TenantMemberOut])
async def list_tenant_members(
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> list[TenantMemberOut]:
    org_id = user["organization_id"]
    cursor = db.users.find({"organization_id": org_id}).sort("created_at", 1)
    out: list[TenantMemberOut] = []
    async for doc in cursor:
        out.append(
            TenantMemberOut(
                id=str(doc["_id"]),
                email=doc["email"],
                username=doc.get("username") or "",
                roles=list(doc.get("roles") or []),
            ),
        )
    return out


@router.post("/invitations", status_code=status.HTTP_201_CREATED)
async def create_invitation(
    body: CreateInvitationIn,
    user: dict = Depends(require_tenant_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, str]:
    s = get_settings()
    if not s.brevo_api_key.strip() or not s.brevo_sender_email.strip():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email delivery is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL.",
        )

    email_norm = body.email.lower().strip()
    if await db.users.find_one({"email": email_norm}):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="That email already has a Vrika account. Invitation not sent.",
        )

    org_id = user["organization_id"]
    now = datetime.now(UTC)

    await db.organization_invitations.update_many(
        {"organization_id": org_id, "email": email_norm, "status": PENDING},
        {"$set": {"status": CANCELLED, "updated_at": now}},
    )

    invite_doc = {
        "organization_id": org_id,
        "email": email_norm,
        "username": body.username.strip(),
        "roles": [body.role],
        "invited_by": user["_id"],
        "status": PENDING,
        "created_at": now,
        "updated_at": now,
        "phone": "",
    }
    insert_res = await db.organization_invitations.insert_one(invite_doc)
    inv_oid = insert_res.inserted_id

    token = secrets.token_urlsafe(32)
    ttl = s.invitation_token_ttl_seconds
    r = get_redis()
    redis_key = f"{ORG_INVITE_REDIS_PREFIX}{token}"
    await r.setex(redis_key, ttl, str(inv_oid))

    org = await db.organizations.find_one({"_id": org_id})
    org_name = org["name"] if org else "Your organization"

    inviter_username = user.get("username") or ""
    inviter_email = user.get("email") or ""
    inviter_display = inviter_username.strip() or inviter_email

    accept_url = f"{s.frontend_url.rstrip('/')}/invite/accept?token={token}"
    subject, html, text = render_invitation_email(
        invitee_username=body.username.strip(),
        organization_name=org_name,
        inviter_display=inviter_display,
        accept_url=accept_url,
    )

    try:
        await send_transactional_email_one(to_email=email_norm, subject=subject, html=html, text=text)
    except Exception:
        logger.exception("Failed to send organization invitation email via Brevo")
        await r.delete(redis_key)
        await db.organization_invitations.delete_one({"_id": inv_oid})
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail="Could not send invitation email. Verify Brevo sender and API key.",
        )

    logger.info(
        "Org invitation sent to %s org_id=%s inviter=%s",
        email_norm,
        str(org_id),
        inviter_display,
    )
    return {"detail": "Invitation sent."}
