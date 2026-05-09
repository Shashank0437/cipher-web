from functools import lru_cache

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _strip_env_quotes(v: object) -> object:
    """`.env` lines like KEY='value' can leave quotes in the string; strip for API keys and emails."""
    if isinstance(v, str):
        return v.strip().strip("'").strip('"')
    return v


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_uri: str = "mongodb://127.0.0.1:27017"
    mongodb_db: str = "cipherstrike"

    redis_url: str = "redis://127.0.0.1:6379/0"

    jwt_secret: str = "change-me-in-production-use-long-random-string"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7

    admin_api_key: str = ""  # required for /admin/* when set; if empty, admin routes reject

    frontend_url: str = "http://localhost:3000"

    # Brevo (https://api.brevo.com) — Transactional Emails / SMTP API.
    brevo_api_key: str = ""
    brevo_sender_email: str = ""  # Must be a verified sender in Brevo.
    brevo_sender_name: str = "CipherStrike"

    # Comma-separated list — contact form notifications go to every address.
    contact_admin_emails: str = ""

    registration_token_ttl_seconds: int = 604800

    # Redis TTL for org invitation signup tokens (default 7 days, same as registration completion).
    invitation_token_ttl_seconds: int = 604800

    cors_origins: str = "http://localhost:3000"

    # NyxStrike agent (Flask) — proxied for workspace tools UI. Not exposed to browsers directly.
    agent_base_url: str = Field(
        default="http://127.0.0.1:8888",
        validation_alias=AliasChoices("AGENT_MICROSERVICE_URL", "AGENT_BASE_URL"),
    )
    agent_api_token: str = ""  # When set, sent as Authorization: Bearer … (matches NYXSTRIKE_API_TOKEN)
    agent_timeout_seconds: float = 10.0
    # Long-lived HTTP timeouts for synchronous tool executions proxied by POST /workspace/tools/run
    agent_tool_run_timeout_seconds: float = Field(
        default=300.0,
        validation_alias=AliasChoices("AGENT_TOOL_RUN_TIMEOUT_SECONDS"),
    )

    @field_validator("brevo_api_key", "brevo_sender_email", "admin_api_key", "agent_api_token", mode="before")
    @classmethod
    def strip_secrets_env_padding(cls, v: object) -> object:
        return _strip_env_quotes(v)


@lru_cache
def get_settings() -> Settings:
    return Settings()


def contact_admin_recipients() -> list[str]:
    """Comma-separated CONTACT_ADMIN_EMAILS → unique addresses (order preserved)."""
    raw = get_settings().contact_admin_emails.strip()
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for part in raw.split(","):
        e = part.strip()
        if not e:
            continue
        key = e.casefold()
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out
