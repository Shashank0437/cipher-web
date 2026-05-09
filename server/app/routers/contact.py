import logging

import httpx
from fastapi import APIRouter, HTTPException, status

from app.config import contact_admin_recipients, get_settings
from app.schemas.contact import ContactSubmissionIn
from app.services.brevo_email import (
    render_contact_admin_email,
    render_contact_thanks_email,
    send_transactional_email,
    send_transactional_email_one,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/contact", tags=["contact"])

EMAIL_HINT = (
    "Confirmation email may fail if Brevo sender is not verified or quotas are exceeded. "
    "Check Brevo → Senders configuration."
)


@router.post("", status_code=status.HTTP_200_OK)
async def submit_contact(body: ContactSubmissionIn) -> dict:
    admins = contact_admin_recipients()
    if not admins:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Contact notifications are not configured. Set CONTACT_ADMIN_EMAILS.",
        )

    s = get_settings()
    if not s.brevo_api_key.strip() or not s.brevo_sender_email.strip():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email delivery is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL.",
        )

    admin_subject, admin_html, admin_text = render_contact_admin_email(
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        email=str(body.email).lower().strip(),
        company=body.company.strip(),
        phone=body.phone.strip() if body.phone else None,
        message=body.message.strip(),
        team_to_emails=admins,
    )

    thanks_subject, thanks_html, thanks_text = render_contact_thanks_email(first_name=body.first_name.strip())

    try:
        # Single Brevo send: all admins in the `to` array (everyone sees each other on To: for reference).
        await send_transactional_email(
            to_addresses=admins,
            subject=admin_subject,
            html=admin_html,
            text=admin_text,
        )
        logger.info("Contact form: admin notification sent to %s", ", ".join(admins))
    except httpx.HTTPStatusError as e:
        logger.error("Brevo admin notify failed: %s", (e.response.text or "")[:600])
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not notify our team by email (Brevo {e.response.status_code}). Verify API key and sender.",
        )
    except Exception:
        logger.exception("Failed to send contact notification to admins via Brevo")
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail="Could not deliver your message. Try again later or email us directly.",
        )

    try:
        await send_transactional_email_one(
            to_email=str(body.email),
            subject=thanks_subject,
            html=thanks_html,
            text=thanks_text,
        )
    except Exception as exc:
        logger.warning("Contact thank-you email failed via Brevo: %s", exc)
        return {
            "detail": "Your message was sent to our team.",
            "confirmation_sent": False,
            "hint": EMAIL_HINT,
        }

    return {"detail": "Message sent. Check your inbox for a confirmation.", "confirmation_sent": True}
