from pydantic import BaseModel, EmailStr, Field


class SsoDiscoverOut(BaseModel):
    sso_available: bool = False
    sso_required: bool = False
    provider_display_name: str = ""
    domain: str = ""


class RegistrationPreviewOut(BaseModel):
    email: str
    username: str
    company_name: str
    sso_available: bool = False
    sso_required: bool = False
    provider_display_name: str = ""


class SsoConfigIn(BaseModel):
    organization_id: str
    domain: str = Field(..., min_length=3, max_length=253)
    provider_display_name: str = Field(..., min_length=1, max_length=200)
    enforced: bool = True
    enabled: bool = True
    idp_entity_id: str = Field(..., min_length=1)
    idp_sso_url: str = Field(..., min_length=1)
    idp_x509_cert: str = Field(..., min_length=1)


class SamlLoginQuery(BaseModel):
    email: EmailStr
    relay: str | None = None
    relay_type: str = "login"
