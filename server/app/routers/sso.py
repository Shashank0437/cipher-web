import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.db import get_database
from app.schemas.sso import RegistrationPreviewOut, SsoDiscoverOut
from app.services.saml_auth import (
    build_saml_login_redirect_url,
    delete_saml_relay,
    get_sp_metadata_xml,
    load_saml_relay,
    process_saml_acs,
    store_saml_relay,
)
from app.services.sso_completion import issue_token_for_saml_relay
from app.services.sso_domain import lookup_sso_config_for_email, sso_discover_payload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["sso"])

APPROVED = "approved"


def _request_https(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    forwarded = request.headers.get("x-forwarded-proto", "")
    return forwarded.split(",")[0].strip().lower() == "https"


@router.get("/sso/discover", response_model=SsoDiscoverOut)
async def sso_discover(
    email: str = Query(..., min_length=3),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> SsoDiscoverOut:
    cfg = await lookup_sso_config_for_email(db, email)
    return SsoDiscoverOut(**sso_discover_payload(cfg))


@router.get("/registration-preview", response_model=RegistrationPreviewOut)
async def registration_preview(
    token: str = Query(..., min_length=8),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> RegistrationPreviewOut:
    from bson import ObjectId
    from bson.errors import InvalidId

    from app.constants import REG_COMPLETE_REDIS_PREFIX
    from app.redis_client import get_redis

    r = get_redis()
    key = f"{REG_COMPLETE_REDIS_PREFIX}{token}"
    raw = await r.get(key)
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")

    try:
        request_id = ObjectId(raw)
    except InvalidId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid token")

    req = await db.registration_requests.find_one({"_id": request_id})
    if not req:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Registration request not found")

    if req["status"] == "completed":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="This registration was already completed")

    if req["status"] != APPROVED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Registration is not ready for activation")

    cfg = await lookup_sso_config_for_email(db, req["email"])
    discover = sso_discover_payload(cfg)

    return RegistrationPreviewOut(
        email=req["email"],
        username=req.get("username") or "",
        company_name=req.get("company_name") or "",
        sso_available=discover["sso_available"],
        sso_required=discover["sso_required"],
        provider_display_name=discover["provider_display_name"],
    )


@router.get("/saml/metadata")
async def saml_metadata() -> Response:
    try:
        xml = get_sp_metadata_xml()
    except ValueError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc
    return Response(content=xml, media_type="application/xml")


@router.get("/saml/login")
async def saml_login(
    request: Request,
    email: str = Query(..., min_length=3),
    relay: str | None = Query(None),
    relay_type: str = Query("login"),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> RedirectResponse:
    email_norm = email.lower().strip()
    cfg = await lookup_sso_config_for_email(db, email_norm)
    if not cfg:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="SSO is not configured for this email domain")

    if relay_type not in ("login", "registration", "invitation"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid relay_type")

    org_id = str(cfg["organization_id"])
    relay_key = await store_saml_relay(
        email=email_norm,
        relay_token=relay,
        relay_type=relay_type,
        org_id=org_id,
    )

    try:
        redirect_url = build_saml_login_redirect_url(
            cfg,
            relay_state=relay_key,
            https=_request_https(request),
            host=request.headers.get("host") or request.url.hostname or "localhost",
            path=request.url.path,
        )
    except Exception:
        logger.exception("Failed to build SAML login redirect for %s", email_norm)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not initiate SSO login") from None

    return RedirectResponse(url=redirect_url, status_code=status.HTTP_302_FOUND)


@router.post("/saml/acs")
async def saml_acs(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> RedirectResponse:
    form = await request.form()
    saml_response = form.get("SAMLResponse")
    relay_state = form.get("RelayState")

    if not saml_response or not relay_state:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Missing SAML response or relay state")

    relay = await load_saml_relay(str(relay_state))
    if not relay:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid or expired SSO session")

    cfg = await lookup_sso_config_for_email(db, relay["email"])
    if not cfg:
        await delete_saml_relay(str(relay_state))
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="SSO configuration not found")

    try:
        email, name_id = process_saml_acs(
            cfg,
            relay_state=str(relay_state),
            https=_request_https(request),
            host=request.headers.get("host") or request.url.hostname or "localhost",
            path=request.url.path,
            saml_response=str(saml_response),
        )
    except ValueError as exc:
        logger.warning("SAML ACS validation failed: %s", exc)
        await delete_saml_relay(str(relay_state))
        s = get_settings()
        err_url = f"{s.frontend_url.rstrip('/')}/login?sso_error={quote(str(exc))}"
        return RedirectResponse(url=err_url, status_code=status.HTTP_302_FOUND)

    try:
        access_token = await issue_token_for_saml_relay(
            db,
            email=email,
            name_id=name_id,
            relay=relay,
            sso_config=cfg,
        )
    except HTTPException as exc:
        await delete_saml_relay(str(relay_state))
        s = get_settings()
        detail = exc.detail if isinstance(exc.detail, str) else "SSO sign-in failed"
        err_url = f"{s.frontend_url.rstrip('/')}/login?sso_error={quote(detail)}"
        return RedirectResponse(url=err_url, status_code=status.HTTP_302_FOUND)
    finally:
        await delete_saml_relay(str(relay_state))

    s = get_settings()
    callback_url = f"{s.frontend_url.rstrip('/')}/auth/sso/callback?token={quote(access_token)}"
    return RedirectResponse(url=callback_url, status_code=status.HTTP_302_FOUND)
