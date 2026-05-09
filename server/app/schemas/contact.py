from pydantic import BaseModel, EmailStr, Field


class ContactSubmissionIn(BaseModel):
    first_name: str = Field(..., min_length=1, max_length=120)
    last_name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    company: str = Field(..., min_length=1, max_length=200)
    phone: str | None = Field(None, max_length=40)
    message: str = Field(..., min_length=1, max_length=8000)
