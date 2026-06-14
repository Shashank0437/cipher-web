"""SSO domain helpers — unit tests (no SAML/xmlsec required)."""

from app.services.sso_domain import extract_email_domain, normalize_domain, sso_discover_payload


def test_extract_email_domain() -> None:
    assert extract_email_domain("User@RIL.com") == "ril.com"
    assert extract_email_domain("bad") == ""


def test_normalize_domain() -> None:
    assert normalize_domain("@RIL.COM") == "ril.com"
    assert normalize_domain("  ril.com ") == "ril.com"


def test_sso_discover_payload() -> None:
    assert sso_discover_payload(None)["sso_available"] is False
    cfg = {"enforced": True, "provider_display_name": "ABCD CORP", "domain": "ril.com"}
    out = sso_discover_payload(cfg)
    assert out["sso_available"] is True
    assert out["sso_required"] is True
    assert out["provider_display_name"] == "ABCD CORP"
