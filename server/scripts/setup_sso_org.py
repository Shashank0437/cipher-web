#!/usr/bin/env python3
"""
Provision an organization + SSO config for an enterprise domain and link a pending registration request.

Usage:
  python scripts/setup_sso_org.py \\
    --org-name auth0corp \\
    --domain robot-mail.com \\
    --find-by-domain \\
    --config-file scripts/idp/auth0corp.json

  python scripts/setup_sso_org.py \\
    --org-name auth0corp \\
    --domain robot-mail.com \\
    --request-id 674a1b2c3d4e5f6789012345 \\
    --config-file scripts/idp/auth0corp.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

_SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(_SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVER_ROOT))

from bson import ObjectId  # noqa: E402
from bson.errors import InvalidId  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.constants import SSO_CONFIGS_COLLECTION  # noqa: E402
from app.services.slug import unique_organization_slug  # noqa: E402
from app.services.sso_domain import extract_email_domain, normalize_domain  # noqa: E402


def _resolve_path(path: str) -> Path:
    p = Path(path)
    if p.is_absolute() and p.exists():
        return p
    script_dir = Path(__file__).resolve().parent
    candidates = [
        p,
        script_dir / p,
        script_dir.parent / p,
        _SERVER_ROOT / p,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return p


def _load_idp_cert(path: str) -> str:
    return _resolve_path(path).read_text(encoding="utf-8").strip()


def _load_config_file(path: str) -> dict:
    cfg_path = _resolve_path(path)
    if not cfg_path.exists():
        raise FileNotFoundError(f"config file not found: {path}")
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    cert_ref = data.get("idp_cert_file")
    if cert_ref and not data.get("idp_x509_cert"):
        cert_path = _resolve_path(str(cfg_path.parent / cert_ref))
        data["idp_x509_cert"] = cert_path.read_text(encoding="utf-8").strip()
    required = ("idp_entity_id", "idp_sso_url", "idp_x509_cert")
    missing = [k for k in required if not data.get(k)]
    if missing:
        raise ValueError(f"config-file missing fields: {', '.join(missing)}")
    return data


async def _resolve_request_id(db, args: argparse.Namespace, domain: str) -> ObjectId | None:
    if args.request_id:
        try:
            return ObjectId(args.request_id)
        except InvalidId:
            print(f"error: invalid request-id: {args.request_id}", file=sys.stderr)
            return None

    if not args.find_by_domain:
        print("error: provide --request-id or --find-by-domain", file=sys.stderr)
        return None

    cursor = db.registration_requests.find({"status": "pending"}).sort("created_at", -1)
    async for req in cursor:
        if extract_email_domain(req.get("email", "")) == domain:
            print(f"Found pending registration request: {req['_id']} ({req['email']})")
            return req["_id"]

    print(
        f"error: no pending registration request found for domain '{domain}'. "
        f"Submit a trial request first with an email @{domain}",
        file=sys.stderr,
    )
    return None


async def run(args: argparse.Namespace) -> int:
    settings = get_settings()
    domain = normalize_domain(args.domain)
    if not domain:
        print("error: invalid domain", file=sys.stderr)
        return 1

    if args.config_file:
        idp = _load_config_file(args.config_file)
        idp_entity_id = idp["idp_entity_id"]
        idp_sso_url = idp["idp_sso_url"]
        idp_x509_cert = idp["idp_x509_cert"]
        provider_name = args.provider_display_name or idp.get("provider_display_name") or args.org_name
        enforced = idp.get("enforced", args.enforced)
    else:
        if not all([args.idp_entity_id, args.idp_sso_url, args.idp_cert_file]):
            print("error: provide --config-file or --idp-entity-id, --idp-sso-url, --idp-cert-file", file=sys.stderr)
            return 1
        idp_entity_id = args.idp_entity_id
        idp_sso_url = args.idp_sso_url
        idp_x509_cert = _load_idp_cert(args.idp_cert_file)
        provider_name = args.provider_display_name or args.org_name
        enforced = args.enforced

    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client[settings.mongodb_db]

    try:
        request_oid = await _resolve_request_id(db, args, domain)
        if not request_oid:
            return 1

        req = await db.registration_requests.find_one({"_id": request_oid})
        if not req:
            print(f"error: registration request not found: {request_oid}", file=sys.stderr)
            return 1

        if req.get("status") != "pending":
            print(
                f"error: registration request status is '{req.get('status')}', expected 'pending'",
                file=sys.stderr,
            )
            return 1

        email_domain = extract_email_domain(req["email"])
        if email_domain != domain:
            print(
                f"error: request email domain '{email_domain}' does not match --domain '{domain}'",
                file=sys.stderr,
            )
            return 1

        existing_domain = await db[SSO_CONFIGS_COLLECTION].find_one({"domain": domain})
        if existing_domain:
            print(f"error: SSO config already exists for domain {domain}", file=sys.stderr)
            return 1

        if req.get("organization_id"):
            print("error: registration request already linked to an organization", file=sys.stderr)
            return 1

        now = datetime.now(UTC)
        slug = await unique_organization_slug(db, args.org_name)
        org_doc = {
            "name": args.org_name.strip(),
            "slug": slug,
            "created_at": now,
            "updated_at": now,
        }
        org_res = await db.organizations.insert_one(org_doc)
        org_id = org_res.inserted_id

        sso_doc = {
            "organization_id": org_id,
            "domain": domain,
            "provider_display_name": provider_name.strip(),
            "enforced": enforced,
            "enabled": True,
            "idp_entity_id": idp_entity_id.strip(),
            "idp_sso_url": idp_sso_url.strip(),
            "idp_x509_cert": idp_x509_cert.strip(),
            "created_at": now,
            "updated_at": now,
        }
        await db[SSO_CONFIGS_COLLECTION].insert_one(sso_doc)

        await db.registration_requests.update_one(
            {"_id": request_oid},
            {"$set": {"organization_id": org_id, "updated_at": now}},
        )

        api_base = settings.api_base_url.rstrip("/")
        metadata_url = f"{api_base}/auth/saml/metadata"
        acs_url = f"{api_base}/auth/saml/acs"

        print("SSO organization provisioned successfully.")
        print(f"  organization_id: {org_id}")
        print(f"  organization_slug: {slug}")
        print(f"  domain: {domain}")
        print(f"  provider_display_name: {provider_name}")
        print(f"  enforced: {enforced}")
        print(f"  registration_request_id: {request_oid}")
        print(f"  SP metadata URL: {metadata_url}")
        print(f"  SP ACS URL (Auth0 callback): {acs_url}")
        print()
        print("Auth0 SAML app settings:")
        print(f"  Callback URL: {acs_url}")
        print(f"  Audience / Identifier: {metadata_url}")
        print()
        print("Next steps:")
        print("  1. Configure Auth0 SAML app with the Callback URL and Audience above.")
        print("  2. Approve the registration request:")
        print(f"     POST {api_base}/admin/registration-requests/{request_oid}/approve")
        print("     Header: X-Admin-Key: <your admin key>")
        print("  3. User opens the completion email link and activates via SSO (no password).")
        return 0
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Provision org + SSO config for enterprise onboarding")
    parser.add_argument("--org-name", required=True, help="Organization display name")
    parser.add_argument("--domain", required=True, help="Email domain e.g. robot-mail.com")
    parser.add_argument("--request-id", default="", help="registration_requests ObjectId")
    parser.add_argument(
        "--find-by-domain",
        action="store_true",
        help="Auto-find latest pending registration request for --domain",
    )
    parser.add_argument("--provider-display-name", default="", help="Button label e.g. auth0corp")
    parser.add_argument("--idp-entity-id", default="", help="SAML IdP entity ID")
    parser.add_argument("--idp-sso-url", default="", help="SAML IdP SSO URL")
    parser.add_argument("--idp-cert-file", default="", help="Path to IdP X.509 certificate PEM")
    parser.add_argument("--config-file", default="", help="JSON file with IdP SAML settings")
    parser.add_argument(
        "--enforced",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Block password login for this domain (default: true)",
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
