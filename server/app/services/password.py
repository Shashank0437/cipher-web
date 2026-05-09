"""Password hashing with bcrypt only (avoid passlib ↔ bcrypt incompatibility)."""

import hashlib

import bcrypt


def _password_key(password: str) -> bytes:
    """32-byte key for bcrypt; avoids the 72-byte password limit and matches verify."""
    return hashlib.sha256(password.encode("utf-8")).digest()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_password_key(password), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_password_key(password), password_hash.encode("ascii"))
    except (ValueError, TypeError):
        return False
