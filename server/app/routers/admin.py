import logging
import secrets
from datetime import UTC, datetime

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.constants import REG_COMPLETE_REDIS_PREFIX
from app.db import get_database
from app.redis_client import get_redis
from app.services.brevo_email import render_approval_email, send_transactional_email_one

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])

PENDING = "pending"
APPROVED = "approved"


async def require_admin_key(x_admin_key: str | None = Header(None, alias="X-Admin-Key")) -> None:
    s = get_settings()
    if not s.admin_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="Admin key is not configured on this server")
    if not x_admin_key or x_admin_key != s.admin_api_key:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.get("/registration-requests", dependencies=[Depends(require_admin_key)])
async def list_registration_requests(
    db: AsyncIOMotorDatabase = Depends(get_database),
    status_filter: str | None = Query(None, alias="status"),
) -> list[dict]:
    q: dict = {}
    if status_filter:
        q["status"] = status_filter
    cursor = db.registration_requests.find(q).sort("created_at", -1).limit(200)
    out: list[dict] = []
    async for doc in cursor:
        out.append(
            {
                "id": str(doc["_id"]),
                "email": doc["email"],
                "username": doc["username"],
                "company_name": doc["company_name"],
                "phone": doc["phone"],
                "status": doc["status"],
                "created_at": doc.get("created_at"),
            },
        )
    return out


@router.post(
    "/registration-requests/{request_id}/approve",
    dependencies=[Depends(require_admin_key)],
)
async def approve_registration_request(
    request_id: str,
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict:
    try:
        oid = ObjectId(request_id)
    except InvalidId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid request id")

    req = await db.registration_requests.find_one({"_id": oid})
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Registration request not found")
    if req["status"] != PENDING:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"Request is not pending (current status: {req['status']})",
        )

    s = get_settings()
    token = secrets.token_urlsafe(32)
    ttl = s.registration_token_ttl_seconds
    r = get_redis()
    redis_key = f"{REG_COMPLETE_REDIS_PREFIX}{token}"
    await r.setex(redis_key, ttl, str(req["_id"]))

    complete_url = f"{s.frontend_url.rstrip('/')}/register/complete?token={token}"
    subject, html, text = render_approval_email(
        recipient_name=req["username"],
        company_name=req["company_name"],
        complete_url=complete_url,
    )

    try:
        logger.info(
            "Approval: sending completion email via Brevo to %s request_id=%s",
            req["email"],
            request_id,
        )
        await send_transactional_email_one(to_email=req["email"], subject=subject, html=html, text=text)
    except Exception:
        logger.exception("Failed to send approval email via Brevo")
        await r.delete(redis_key)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail="Could not send approval email; request left pending. Check Brevo API key and verified sender.",
        )

    now = datetime.now(UTC)
    await db.registration_requests.update_one(
        {"_id": oid},
        {"$set": {"status": APPROVED, "updated_at": now, "approved_at": now}},
    )

    return {"detail": "Approved; completion email sent."}
