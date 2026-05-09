from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class TenantMemberOut(BaseModel):
    id: str
    email: str
    username: str
    roles: list[str]


class CreateInvitationIn(BaseModel):
    email: EmailStr
    username: str = Field(..., min_length=1, max_length=120)
    role: Literal["tenant_member", "tenant_admin"]


class InvitationPreviewOut(BaseModel):
    organization_name: str
    inviter_display: str
    invitee_email: str
    invitee_username: str
