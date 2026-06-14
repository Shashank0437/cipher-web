#!/usr/bin/env python3
"""
Provision an organization + SSO config for an enterprise domain and link a pending registration request.

Usage:
  python scripts/setup_sso_org.py \\
    --org-name "ABCD CORP" \\
    --domain ril.com \\
    --request-id 674a1b2c3d4e5f6789012345 \\
    --provider-display-name "ABCD CORP" \\
    --idp-entity-id "https://idp.example.com/metadata" \\
    --idp-sso-url "https://idp.example.com/sso" \\
    --idp-cert-file /path/to/idp.pem

  # Or load IdP settings from JSON:
  python scripts/setup_sso_org.py --org-name "ABCD CORP" --domain ril.com \\
    --request-id 674a... --config-file sso_idp.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

# Allow running from server/ or repo root
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


def _load_idp_cert(path: str) -> str:
    return Path(path).read_text(encoding="utf-8").strip()


def _load_config_file(path: str) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    required = ("idp_entity_id", "idp_sso_url", "idp_x509_cert")
    missing = [k for k in required if not data.get(k)]
    if missing:
        raise ValueError(f"config-file missing fields: {', '.join(missing)}")
    if data.get("idp_cert_file") and not data.get("idp_x509_cert"):
        data["idp_x509_cert"] = _load_idp_cert(data["idp_cert_file"])
    return data


async def run(args: argparse.Namespace) -> int:
    settings = get_settings()
    domain = normalize_domain(args.domain)
    if not domain:
        print("error: invalid domain", file=sys.stderr)
        return 1

    try:
        request_oid = ObjectId(args.request_id)
    except InvalidId:
        print(f"error: invalid request-id: {args.request_id}", file=sys.stderr)
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
        req = await db.registration_requests.find_one({"_id": request_oid})
        if not req:
            print(f"error: registration request not found: {args.request_id}", file=sys.stderr)
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

        print("SSO organization provisioned successfully.")
        print(f"  organization_id: {org_id}")
        print(f"  organization_slug: {slug}")
        print(f"  domain: {domain}")
        print(f"  provider_display_name: {provider_name}")
        print(f"  enforced: {enforced}")
        print(f"  registration_request_id: {request_oid}")
        print(f"  SP metadata URL: {metadata_url}")
        print()
        print("Next steps:")
        print("  1. Configure your IdP with the SP metadata URL above.")
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
    parser.add_argument("--domain", required=True, help="Email domain e.g. ril.com")
    parser.add_argument("--request-id", required=True, help="registration_requests ObjectId")
    parser.add_argument("--provider-display-name", default="", help="Button label e.g. ABCD CORP")
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
