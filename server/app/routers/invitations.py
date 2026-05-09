from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.constants import ORG_INVITE_REDIS_PREFIX
from app.db import get_database
from app.redis_client import get_redis
from app.schemas.tenant import InvitationPreviewOut

router = APIRouter(prefix="/invitations", tags=["invitations"])

PENDING = "pending"


@router.get("/preview", response_model=InvitationPreviewOut)
async def preview_invitation(
    token: str = Query(..., min_length=8),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> InvitationPreviewOut:
    r = get_redis()
    key = f"{ORG_INVITE_REDIS_PREFIX}{token}"
    raw = await r.get(key)
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid or expired invitation link")

    try:
        oid = ObjectId(raw)
    except InvalidId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid invitation")

    inv = await db.organization_invitations.find_one({"_id": oid})
    if not inv or inv["status"] != PENDING:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="This invitation is no longer valid.",
        )

    org = await db.organizations.find_one({"_id": inv["organization_id"]})
    org_name = org["name"] if org else "CipherStrike workspace"

    inviter = await db.users.find_one({"_id": inv["invited_by"]})
    if inviter:
        inviter_display = (inviter.get("username") or "").strip() or inviter.get("email") or "A teammate"
    else:
        inviter_display = "A teammate"

    return InvitationPreviewOut(
        organization_name=org_name,
        inviter_display=inviter_display,
        invitee_email=inv["email"],
        invitee_username=inv["username"],
    )
