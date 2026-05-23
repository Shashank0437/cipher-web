from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterRequestIn(BaseModel):
    email: EmailStr
    username: str = Field(..., min_length=1, max_length=120)
    company_name: str = Field(..., min_length=1, max_length=200)
    phone: str = Field(..., min_length=5, max_length=40)


class CompleteRegistrationIn(BaseModel):
    token: str = Field(..., min_length=8)
    password: str = Field(..., min_length=8, max_length=256)


class CompleteInvitationIn(BaseModel):
    token: str = Field(..., min_length=8)
    password: str = Field(..., min_length=8, max_length=256)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=256)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=8, max_length=256)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MeOut(BaseModel):
    id: str
    email: str
    username: str
    tenant_id: str
    roles: list[str]
    organization_name: str = ""


class UpdateProfileIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=120)

    @field_validator("username", mode="before")
    @classmethod
    def strip_username(cls, v: object) -> object:
        if isinstance(v, str):
            return v.strip()
        return v
