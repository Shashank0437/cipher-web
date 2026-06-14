from datetime import UTC, datetime

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import HTTPException, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.constants import ORG_INVITE_REDIS_PREFIX, REG_COMPLETE_REDIS_PREFIX
from app.redis_client import get_redis
from app.services.jwt_tokens import create_access_token
from app.services.sso_domain import extract_email_domain, lookup_sso_config_for_email


async def _resolve_org_id_from_relay(db: AsyncIOMotorDatabase, relay: dict, sso_config: dict) -> ObjectId:
    org_id = sso_config.get("organization_id")
    if not org_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="SSO configuration is missing organization")
    return org_id if isinstance(org_id, ObjectId) else ObjectId(str(org_id))


async def complete_saml_login(
    db: AsyncIOMotorDatabase,
    *,
    email: str,
    name_id: str,
    relay: dict,
    sso_config: dict,
) -> str:
    """Return JWT access token for an existing user."""
    if relay.get("email") and relay["email"] != email:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="SAML email does not match the sign-in request")

    user = await db.users.find_one({"email": email})
    if not user:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="No account found for this email. Complete registration or accept your invitation first.",
        )

    org_id = user["organization_id"]
    cfg_org = sso_config.get("organization_id")
    if cfg_org and str(cfg_org) != str(org_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="This account does not belong to the SSO organization")

    now = datetime.now(UTC)
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"sso_subject_id": name_id, "updated_at": now}},
    )

    roles = user.get("roles") or ["tenant_member"]
    return create_access_token(
        user_id=str(user["_id"]),
        email=user["email"],
        tenant_id=str(org_id),
        roles=roles,
    )


async def complete_saml_registration(
    db: AsyncIOMotorDatabase,
    *,
    email: str,
    name_id: str,
    relay: dict,
    sso_config: dict,
) -> str:
    """Complete approved registration via SAML; org must be pre-created."""
    relay_token = relay.get("relay_token") or ""
    if not relay_token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Missing registration token for SSO completion")

    r = get_redis()
    key = f"{REG_COMPLETE_REDIS_PREFIX}{relay_token}"
    raw = await r.get(key)
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid or expired registration link")

    try:
        request_id = ObjectId(raw)
    except InvalidId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid registration token")

    req = await db.registration_requests.find_one({"_id": request_id})
    if not req:
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Registration request not found")

    if req["status"] == "completed":
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="This registration was already completed")

    if req["status"] != "approved":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Registration is not ready for activation")

    email_norm = req["email"]
    if email_norm != email:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="SAML email does not match the registration request")

    if relay.get("email") and relay["email"] != email:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="SAML email does not match the sign-in request")

    domain = extract_email_domain(email_norm)
    if domain != sso_config.get("domain"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Email domain does not match SSO configuration")

    org_id = req.get("organization_id")
    if not org_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="Organization not pre-configured for this SSO registration. Contact your administrator.",
        )

    cfg_org = sso_config.get("organization_id")
    if str(cfg_org) != str(org_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="SSO organization does not match registration")

    if await db.users.find_one({"email": email_norm}):
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="An account with this email already exists")

    now = datetime.now(UTC)
    roles = ["tenant_admin"]
    user_doc = {
        "email": email_norm,
        "username": req["username"],
        "phone": req.get("phone") or "",
        "password_hash": None,
        "sso_subject_id": name_id,
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
                "status": "completed",
                "completed_user_id": user_res.inserted_id,
                "completed_org_id": org_id,
                "updated_at": now,
            },
        },
    )
    await r.delete(key)

    return create_access_token(
        user_id=str(user_res.inserted_id),
        email=email_norm,
        tenant_id=str(org_id),
        roles=roles,
    )


async def complete_saml_invitation(
    db: AsyncIOMotorDatabase,
    *,
    email: str,
    name_id: str,
    relay: dict,
    sso_config: dict,
) -> str:
    relay_token = relay.get("relay_token") or ""
    if not relay_token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Missing invitation token for SSO completion")

    r = get_redis()
    key = f"{ORG_INVITE_REDIS_PREFIX}{relay_token}"
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

    if inv["status"] != "pending":
        await r.delete(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="This invitation is no longer valid")

    email_norm = inv["email"]
    if email_norm != email:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="SAML email does not match the invitation")

    if relay.get("email") and relay["email"] != email:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="SAML email does not match the sign-in request")

    cfg_org = sso_config.get("organization_id")
    if str(cfg_org) != str(inv["organization_id"]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Invitation organization does not match SSO configuration")

    if await db.users.find_one({"email": email_norm}):
        await r.delete(key)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="An account with this email already exists. Sign in instead.",
        )

    roles = list(inv.get("roles") or ["tenant_member"])
    now = datetime.now(UTC)
    user_doc = {
        "email": email_norm,
        "username": inv["username"],
        "phone": inv.get("phone") or "",
        "password_hash": None,
        "sso_subject_id": name_id,
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
                "status": "accepted",
                "accepted_user_id": user_res.inserted_id,
                "updated_at": now,
            },
        },
    )
    await r.delete(key)

    return create_access_token(
        user_id=str(user_res.inserted_id),
        email=email_norm,
        tenant_id=str(inv["organization_id"]),
        roles=roles,
    )


async def issue_token_for_saml_relay(
    db: AsyncIOMotorDatabase,
    *,
    email: str,
    name_id: str,
    relay: dict,
    sso_config: dict,
) -> str:
    relay_type = relay.get("relay_type") or "login"
    if relay_type == "registration":
        return await complete_saml_registration(db, email=email, name_id=name_id, relay=relay, sso_config=sso_config)
    if relay_type == "invitation":
        return await complete_saml_invitation(db, email=email, name_id=name_id, relay=relay, sso_config=sso_config)
    return await complete_saml_login(db, email=email, name_id=name_id, relay=relay, sso_config=sso_config)
