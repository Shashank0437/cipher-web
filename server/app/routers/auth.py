from datetime import UTC, datetime

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.constants import ORG_INVITE_REDIS_PREFIX, REG_COMPLETE_REDIS_PREFIX
from app.db import get_database
from app.dependencies.auth import require_auth_user
from app.redis_client import get_redis
from app.schemas.auth import (
    ChangePasswordIn,
    CompleteInvitationIn,
    CompleteRegistrationIn,
    LoginIn,
    MeOut,
    RegisterRequestIn,
    TokenOut,
    UpdateProfileIn,
)
from app.services.jwt_tokens import create_access_token
from app.services.password import hash_password, verify_password
from app.services.slug import unique_organization_slug
from app.services.sso_domain import lookup_sso_config_for_email

router = APIRouter(prefix="/auth", tags=["auth"])

PENDING = "pending"
APPROVED = "approved"
COMPLETED = "completed"
REJECTED = "rejected"


async def _reject_if_sso_enforced(
    db: AsyncIOMotorDatabase,
    email: str,
    *,
    action: str,
    status_code: int = status.HTTP_403_FORBIDDEN,
) -> None:
    cfg = await lookup_sso_config_for_email(db, email)
    if cfg and cfg.get("enforced"):
        provider = cfg.get("provider_display_name") or cfg.get("domain") or "your organization"
        raise HTTPException(
            status_code,
            detail=f"Password {action} is disabled for this domain. Sign in with {provider} instead.",
        )


@router.post("/register-request", status_code=status.HTTP_201_CREATED)
async def register_request(body: RegisterRequestIn, db: AsyncIOMotorDatabase = Depends(get_database)) -> dict:
    email_norm = body.email.lower().strip()
    existing_user = await db.users.find_one({"email": email_norm})
    if existing_user:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="An account with this email already exists")

    dup_pending = await db.registration_requests.find_one(
        {"email": email_norm, "status": {"$in": [PENDING, APPROVED]}},
    )
    if dup_pending:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="A registration is already pending or awaiting password setup for this email",
        )

    now = datetime.now(UTC)
    doc = {
        "email": email_norm,
        "username": body.username.strip(),
        "company_name": body.company_name.strip(),
        "phone": body.phone.strip(),
        "status": PENDING,
        "created_at": now,
        "updated_at": now,
    }
    await db.registration_requests.insert_one(doc)
    return {"detail": "Registration request received. You will receive an email when an administrator approves it."}


@router.post("/complete-registration", response_model=TokenOut)
async def complete_registration(
    body: CompleteRegistrationIn,
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> TokenOut:
    r = get_redis()
    key = f"{REG_COMPLETE_REDIS_PREFIX}{body.token}"
    raw = await r.get(key)
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")

    try:
        request_id = ObjectId(raw)
    except InvalidId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid token")

    req = await db.registration_requests.find_one({"_id": request_id})
    if not req:
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Registration request not found")

    if req["status"] == COMPLETED:
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="This registration was already completed")

    if req["status"] != APPROVED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Registration is not ready for password setup")

    email_norm = req["email"]
    if await db.users.find_one({"email": email_norm}):
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="An account with this email already exists")

    await _reject_if_sso_enforced(db, email_norm, action="registration", status_code=status.HTTP_400_BAD_REQUEST)
    if req.get("organization_id"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="This registration must be completed via SSO. Use the activation link from your email.",
        )

    company = req["company_name"]
    slug = await unique_organization_slug(db, company)
    # Hash before any inserts so a password/hashing failure cannot leave orphan organizations
    pwd_hash = hash_password(body.password)
    now = datetime.now(UTC)

    org_doc = {
        "name": company,
        "slug": slug,
        "created_at": now,
        "updated_at": now,
    }
    org_res = await db.organizations.insert_one(org_doc)
    org_id = org_res.inserted_id

    roles = ["tenant_admin"]
    user_doc = {
        "email": email_norm,
        "username": req["username"],
        "phone": req["phone"],
        "password_hash": pwd_hash,
        "organization_id": org_id,
        "roles": roles,
        "created_at": now,
        "updated_at": now,
    }
    user_res = await db.users.insert_one(user_doc)

    await db.registration_requests.update_one(
        {"_id": request_id},
        {
            "$set": {
                "status": COMPLETED,
                "completed_user_id": user_res.inserted_id,
                "completed_org_id": org_id,
                "updated_at": now,
            },
        },
    )
    await r.delete(key)

    token = create_access_token(
        user_id=str(user_res.inserted_id),
        email=email_norm,
        tenant_id=str(org_id),
        roles=roles,
    )
    return TokenOut(access_token=token)


INVITE_PENDING = "pending"
INVITE_ACCEPTED = "accepted"


@router.post("/complete-invitation", response_model=TokenOut)
async def complete_invitation(
    body: CompleteInvitationIn,
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> TokenOut:
    r = get_redis()
    key = f"{ORG_INVITE_REDIS_PREFIX}{body.token}"
    raw = await r.get(key)
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid or expired invitation link")

    try:
        invite_id = ObjectId(raw)
    except InvalidId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid invitation")

    inv = await db.organization_invitations.find_one({"_id": invite_id})
    if not inv:
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invitation not found")

    if inv["status"] != INVITE_PENDING:
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="This invitation is no longer valid")

    email_norm = inv["email"]
    if await db.users.find_one({"email": email_norm}):
        await r.delete(key)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="An account with this email already exists. Sign in instead.",
        )

    await _reject_if_sso_enforced(
        db,
        email_norm,
        action="invitation acceptance",
        status_code=status.HTTP_400_BAD_REQUEST,
    )

    roles = list(inv.get("roles") or ["tenant_member"])
    pwd_hash = hash_password(body.password)
    now = datetime.now(UTC)

    user_doc = {
        "email": email_norm,
        "username": inv["username"],
        "phone": inv.get("phone") or "",
        "password_hash": pwd_hash,
        "organization_id": inv["organization_id"],
        "roles": roles,
        "created_at": now,
        "updated_at": now,
    }
    user_res = await db.users.insert_one(user_doc)

    await db.organization_invitations.update_one(
        {"_id": invite_id},
        {
            "$set": {
                "status": INVITE_ACCEPTED,
                "accepted_user_id": user_res.inserted_id,
                "updated_at": now,
            },
        },
    )
    await r.delete(key)

    token = create_access_token(
        user_id=str(user_res.inserted_id),
        email=email_norm,
        tenant_id=str(inv["organization_id"]),
        roles=roles,
    )
    return TokenOut(access_token=token)


@router.post("/login", response_model=TokenOut)
async def login(body: LoginIn, db: AsyncIOMotorDatabase = Depends(get_database)) -> TokenOut:
    email_norm = body.email.lower().strip()
    await _reject_if_sso_enforced(db, email_norm, action="sign-in")

    user = await db.users.find_one({"email": email_norm})
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    pwd_hash = user.get("password_hash")
    if not pwd_hash:
        cfg = await lookup_sso_config_for_email(db, email_norm)
        provider = (cfg or {}).get("provider_display_name") or "your organization SSO"
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=f"This account uses SSO only. Sign in with {provider}.",
        )

    if not verify_password(body.password, pwd_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    oid = user["_id"]
    org_id = user["organization_id"]
    roles = user.get("roles") or ["tenant_member"]
    token = create_access_token(
        user_id=str(oid),
        email=user["email"],
        tenant_id=str(org_id),
        roles=roles,
    )
    return TokenOut(access_token=token)


@router.get("/me", response_model=MeOut)
async def me(
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> MeOut:
    org = await db.organizations.find_one({"_id": user["organization_id"]})
    org_name = org.get("name") if org else ""
    return MeOut(
        id=str(user["_id"]),
        email=user["email"],
        username=user.get("username") or "",
        tenant_id=str(user["organization_id"]),
        roles=list(user.get("roles") or []),
        organization_name=org_name,
    )


@router.patch("/me", response_model=MeOut)
async def patch_me(
    body: UpdateProfileIn,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> MeOut:
    now = datetime.now(UTC)
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"username": body.username, "updated_at": now}},
    )
    org = await db.organizations.find_one({"_id": user["organization_id"]})
    org_name = org.get("name") if org else ""
    return MeOut(
        id=str(user["_id"]),
        email=user["email"],
        username=body.username,
        tenant_id=str(user["organization_id"]),
        roles=list(user.get("roles") or []),
        organization_name=org_name,
    )


@router.post("/change-password", status_code=status.HTTP_200_OK)
async def change_password(
    body: ChangePasswordIn,
    user: dict = Depends(require_auth_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict[str, str]:
    pwd_hash = user.get("password_hash")
    if not pwd_hash:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="This account uses SSO only and does not have a password to change.",
        )

    if not verify_password(body.current_password, pwd_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")

    if body.current_password == body.new_password:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from your current password",
        )

    new_hash = hash_password(body.new_password)
    now = datetime.now(UTC)
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": new_hash, "updated_at": now}},
    )
    return {"detail": "Password updated successfully"}
