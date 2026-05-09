from datetime import UTC, datetime, timedelta

from jose import jwt

from app.config import Settings, get_settings


def create_access_token(
    *,
    user_id: str,
    email: str,
    tenant_id: str,
    roles: list[str],
    settings: Settings | None = None,
) -> str:
    s = settings or get_settings()
    now = datetime.now(UTC)
    expire = now + timedelta(minutes=s.jwt_expire_minutes)
    payload = {
        "sub": user_id,
        "email": email,
        "tenant_id": tenant_id,
        "roles": roles,
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode_access_token(token: str, settings: Settings | None = None) -> dict:
    s = settings or get_settings()
    return jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
