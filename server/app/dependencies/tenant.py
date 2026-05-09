from fastapi import Depends, HTTPException, status

from app.dependencies.auth import require_auth_user


async def require_tenant_admin(user: dict = Depends(require_auth_user)) -> dict:
    roles = user.get("roles") or []
    if "tenant_admin" not in roles:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Tenant administrator role required",
        )
    return user
