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

    # When True (default), chat tool execution uses Redis Streams for live stdout/stderr tails (requires Redis + agent support).
    agent_tool_log_streams_enabled: bool = Field(default=True)

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
    # route-intent calls an LLM on the agent; default generic timeout is often too low.
    agent_route_intent_timeout_seconds: float = Field(
        default=60.0,
        ge=5.0,
        le=300.0,
        validation_alias=AliasChoices("AGENT_ROUTE_INTENT_TIMEOUT_SECONDS"),
    )
    # Long-lived HTTP timeouts for synchronous tool executions proxied by POST /workspace/tools/run
    agent_tool_run_timeout_seconds: float = Field(
        default=300.0,
        validation_alias=AliasChoices("AGENT_TOOL_RUN_TIMEOUT_SECONDS"),
    )
    # Agent bridge (Flask /api/cipherstrike/*) — optional shared secret with NyxStrike CIPHERSTRIKE_BRIDGE_SECRET.
    cipherstrike_bridge_secret: str = ""
    agent_llm_stream_timeout_seconds: float = Field(
        default=600.0,
        validation_alias=AliasChoices("AGENT_LLM_STREAM_TIMEOUT_SECONDS"),
    )

    # Router for /workspace/agent-chat — max tool names route-intent may bind → schemas for main LLM (≤24).
    agent_router_max_tools: int = Field(default=16, ge=1, le=24)

    # Rolling summary: when non-zero, summarize older turns once thread exceeds this message count (Mongo session doc).
    agent_chat_summarize_after_messages: int = Field(default=0, ge=0, le=500)

    # Persona for /workspace/agent-chat (Mongo-backed chat).
    agent_chat_system_prompt: str = (
        "You are CipherStrike, an expert penetration testing AI assistant. "
        "Be concise, actionable, and safety-conscious and ready to test any website or application. "
        "When the user names a target (URL, host, or scope) or asks to run a test, prefer invoking "
        "the tools provided in this turn (function calls) to gather evidence — not long methodology-only lectures. "
        "You may return **multiple parallel tool_calls in a single assistant message**. "
        "For comprehensive pentests or when many scanners are listed, use **several or all** relevant tools at once "
        "(often on the order of ~10) rather than one mega-tool, unless the user explicitly asks for smart-scan / orchestration only. "
        "Reserve smart-scan-style meta-tools when the user wants a single orchestrated pass or when discrete scanners are not listed."
    )

    @field_validator(
        "brevo_api_key",
        "brevo_sender_email",
        "admin_api_key",
        "agent_api_token",
        "cipherstrike_bridge_secret",
        mode="before",
    )
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
