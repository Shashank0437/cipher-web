import json
import secrets
from typing import Any

from onelogin.saml2.auth import OneLogin_Saml2_Auth
from onelogin.saml2.settings import OneLogin_Saml2_Settings

from app.config import get_settings
from app.constants import SAML_RELAY_REDIS_PREFIX
from app.redis_client import get_redis


def _sp_entity_id() -> str:
    s = get_settings()
    if s.saml_sp_entity_id:
        return s.saml_sp_entity_id
    return f"{s.api_base_url.rstrip('/')}/auth/saml/metadata"


def _acs_url() -> str:
    s = get_settings()
    if s.saml_acs_url:
        return s.saml_acs_url
    return f"{s.api_base_url.rstrip('/')}/auth/saml/acs"


def _format_cert_pem(cert: str) -> str:
    c = cert.strip()
    if "BEGIN CERTIFICATE" in c:
        return c
    # Allow single-line base64 cert bodies stored in DB
    lines = [c[i : i + 64] for i in range(0, len(c), 64)]
    body = "\n".join(lines)
    return f"-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----"


def build_saml_settings(sso_config: dict) -> dict[str, Any]:
    s = get_settings()
    sp_cert = _format_cert_pem(s.saml_sp_x509_cert) if s.saml_sp_x509_cert else ""
    idp_cert = _format_cert_pem(sso_config["idp_x509_cert"])

    settings: dict[str, Any] = {
        "strict": True,
        "debug": False,
        "sp": {
            "entityId": _sp_entity_id(),
            "assertionConsumerService": {
                "url": _acs_url(),
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        },
        "idp": {
            "entityId": sso_config["idp_entity_id"],
            "singleSignOnService": {
                "url": sso_config["idp_sso_url"],
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "x509cert": idp_cert,
        },
        "security": {
            "wantAssertionsSigned": True,
            "wantMessagesSigned": False,
            "authnRequestsSigned": bool(s.saml_sp_private_key),
        },
    }

    if sp_cert:
        settings["sp"]["x509cert"] = sp_cert
    if s.saml_sp_private_key:
        settings["sp"]["privateKey"] = s.saml_sp_private_key.strip()

    return settings


def _prepare_request(
    *,
    https: bool,
    host: str,
    path: str,
    query_params: dict[str, list[str]] | None = None,
    post_data: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "https": "on" if https else "off",
        "http_host": host,
        "script_name": path,
        "get_data": query_params or {},
        "post_data": post_data or {},
    }


def get_sp_metadata_xml() -> str:
    """Return SP metadata XML (uses global SP settings without IdP)."""
    s = get_settings()
    settings = {
        "strict": True,
        "debug": False,
        "sp": {
            "entityId": _sp_entity_id(),
            "assertionConsumerService": {
                "url": _acs_url(),
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        },
        "idp": {
            "entityId": "placeholder",
            "singleSignOnService": {"url": "https://placeholder.invalid/sso", "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"},
            "x509cert": "",
        },
    }
    if s.saml_sp_x509_cert:
        settings["sp"]["x509cert"] = _format_cert_pem(s.saml_sp_x509_cert)
    if s.saml_sp_private_key:
        settings["sp"]["privateKey"] = s.saml_sp_private_key.strip()

    saml_settings = OneLogin_Saml2_Settings(settings=settings, sp_validation_only=True)
    metadata = saml_settings.get_sp_metadata()
    errors = saml_settings.validate_metadata(metadata)
    if errors:
        raise ValueError(f"Invalid SP metadata: {errors}")
    return metadata


async def store_saml_relay(
    *,
    email: str,
    relay_token: str | None,
    relay_type: str,
    org_id: str,
) -> str:
    """Store relay context in Redis; return RelayState key."""
    relay_key = secrets.token_urlsafe(24)
    payload = {
        "email": email.lower().strip(),
        "relay_token": relay_token or "",
        "relay_type": relay_type,
        "org_id": org_id,
    }
    r = get_redis()
    ttl = get_settings().saml_relay_ttl_seconds
    await r.setex(f"{SAML_RELAY_REDIS_PREFIX}{relay_key}", ttl, json.dumps(payload))
    return relay_key


async def load_saml_relay(relay_key: str) -> dict | None:
    r = get_redis()
    raw = await r.get(f"{SAML_RELAY_REDIS_PREFIX}{relay_key}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def delete_saml_relay(relay_key: str) -> None:
    r = get_redis()
    await r.delete(f"{SAML_RELAY_REDIS_PREFIX}{relay_key}")


def build_saml_login_redirect_url(
    sso_config: dict,
    *,
    relay_state: str,
    https: bool,
    host: str,
    path: str,
) -> str:
    settings = build_saml_settings(sso_config)
    req = _prepare_request(https=https, host=host, path=path)
    auth = OneLogin_Saml2_Auth(req, settings)
    return auth.login(return_to=relay_state, force_authn=False, is_passive=False, set_nameid_policy=True)


def process_saml_acs(
    sso_config: dict,
    *,
    relay_state: str,
    https: bool,
    host: str,
    path: str,
    saml_response: str,
) -> tuple[str, str]:
    """
    Validate SAML response. Returns (email, name_id).
    Raises ValueError on validation failure.
    """
    settings = build_saml_settings(sso_config)
    req = _prepare_request(
        https=https,
        host=host,
        path=path,
        post_data={"SAMLResponse": saml_response, "RelayState": relay_state},
    )
    auth = OneLogin_Saml2_Auth(req, settings)
    auth.process_response()
    errors = auth.get_errors()
    if errors:
        reason = auth.get_last_error_reason() or ""
        raise ValueError(f"SAML validation failed: {errors} {reason}".strip())

    if not auth.is_authenticated():
        raise ValueError("SAML assertion did not authenticate the user")

    name_id = (auth.get_nameid() or "").strip()
    attrs = auth.get_attributes() or {}
    email = (
        (attrs.get("email") or [None])[0]
        or (attrs.get("mail") or [None])[0]
        or (attrs.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress") or [None])[0]
        or name_id
    )
    email = email.lower().strip()
    if not email or "@" not in email:
        raise ValueError("SAML assertion did not contain a valid email address")
    return email, name_id
