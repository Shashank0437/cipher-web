"""Transactional email via [Brevo](https://developers.brevo.com/reference/sendtransacemail) SMTP API."""

import logging
from pathlib import Path

import httpx
from jinja2 import Environment, FileSystemLoader

from app.config import get_settings

logger = logging.getLogger(__name__)

BREVO_TRANSACTIONAL_URL = "https://api.brevo.com/v3/smtp/email"

_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates" / "email"
_env = Environment(loader=FileSystemLoader(str(_TEMPLATE_DIR)), autoescape=True)


def render_approval_email(
    *,
    recipient_name: str,
    company_name: str,
    complete_url: str,
) -> tuple[str, str, str]:
    """Returns subject, html_body, text_body."""
    html_t = _env.get_template("approval.html.j2")
    text_t = _env.get_template("approval.txt.j2")
    ctx = {
        "recipient_name": recipient_name,
        "company_name": company_name,
        "complete_url": complete_url,
        "preheader": "Finish setting up your Vrika workspace.",
    }
    subject = "Your Vrika access request was approved"
    return subject, html_t.render(**ctx), text_t.render(**ctx)


def render_invitation_email(
    *,
    invitee_username: str,
    organization_name: str,
    inviter_display: str,
    accept_url: str,
) -> tuple[str, str, str]:
    html_t = _env.get_template("invitation.html.j2")
    text_t = _env.get_template("invitation.txt.j2")
    ctx = {
        "invitee_username": invitee_username,
        "organization_name": organization_name,
        "inviter_display": inviter_display,
        "accept_url": accept_url,
        "preheader": f"{inviter_display} invited you to join {organization_name} on Vrika.",
    }
    subject = f"You're invited to join {organization_name} on Vrika"
    return subject, html_t.render(**ctx), text_t.render(**ctx)


async def send_transactional_email(
    *,
    to_addresses: list[str],
    subject: str,
    html: str,
    text: str,
) -> None:
    """Send one message; every address in `to_addresses` is placed in Brevo's JSON `to` array (all visible To:)."""
    s = get_settings()
    if not s.brevo_api_key or not s.brevo_sender_email.strip():
        raise RuntimeError("BREVO_API_KEY and BREVO_SENDER_EMAIL must be set to send email")

    recipients: list[dict[str, str]] = []
    for raw in to_addresses:
        e = raw.strip().lower()
        if e:
            recipients.append({"email": e})

    if not recipients:
        raise ValueError("No recipient addresses")

    payload: dict[str, object] = {
        "sender": {"email": s.brevo_sender_email.strip(), "name": (s.brevo_sender_name or "Vrika").strip()},
        "to": recipients,
        "subject": subject,
        "htmlContent": html,
        "textContent": text,
    }

    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": s.brevo_api_key,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(BREVO_TRANSACTIONAL_URL, headers=headers, json=payload)
        if r.is_error:
            snippet = (r.text or "")[:600]
            logger.warning("Brevo transactional email failed %s → %s", r.status_code, snippet)
        r.raise_for_status()
    try:
        data = r.json()
        mid = data.get("messageId")
        if mid:
            logger.info("Brevo accepted transactional email messageId=%s to=%s", mid, recipients)
        else:
            logger.info("Brevo transactional email sent (no messageId in body) to=%s", recipients)
    except Exception:
        logger.info("Brevo transactional email sent (non-JSON body) status=%s", r.status_code)


async def send_transactional_email_one(
    *,
    to_email: str,
    subject: str,
    html: str,
    text: str,
) -> None:
    await send_transactional_email(to_addresses=[to_email], subject=subject, html=html, text=text)


def render_contact_admin_email(
    *,
    first_name: str,
    last_name: str,
    email: str,
    company: str,
    phone: str | None,
    message: str,
    team_to_emails: list[str],
) -> tuple[str, str, str]:
    html_t = _env.get_template("contact_lead_admin.html.j2")
    text_t = _env.get_template("contact_lead_admin.txt.j2")
    ctx = {
        "first_name": first_name,
        "last_name": last_name,
        "email": email,
        "company": company,
        "phone": phone or "",
        "message": message,
        "team_to_emails": team_to_emails,
        "team_to_line": ", ".join(team_to_emails),
        "preheader": "New lead from the Vrika marketing site.",
    }
    subject = f"[Vrika] Contact: {first_name} {last_name}"
    return subject, html_t.render(**ctx), text_t.render(**ctx)


def render_contact_thanks_email(*, first_name: str) -> tuple[str, str, str]:
    html_t = _env.get_template("contact_thanks_user.html.j2")
    text_t = _env.get_template("contact_thanks_user.txt.j2")
    ctx = {
        "first_name": first_name,
        "preheader": "We received your message and will be in touch.",
    }
    subject = "Thanks for contacting Vrika"
    return subject, html_t.render(**ctx), text_t.render(**ctx)
