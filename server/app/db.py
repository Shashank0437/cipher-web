from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.config import get_settings
from app.constants import (
    AGENT_CHAT_MESSAGES_COLLECTION,
    AGENT_CHAT_SESSIONS_COLLECTION,
    ORG_TOOL_POLICY_COLLECTION,
    TOOL_EXECUTION_LOG_COLLECTION,
)


class Mongo:
    client: AsyncIOMotorClient | None = None


mongo = Mongo()


async def get_database() -> AsyncIOMotorDatabase:
    if mongo.client is None:
        raise RuntimeError("Database not initialized")
    settings = get_settings()
    return mongo.client[settings.mongodb_db]


async def init_db() -> None:
    settings = get_settings()
    mongo.client = AsyncIOMotorClient(settings.mongodb_uri)
    db = mongo.client[settings.mongodb_db]
    await db.organizations.create_index("slug", unique=True)
    await db.users.create_index("email", unique=True)
    await db.users.create_index("organization_id")
    await db.registration_requests.create_index("email")
    await db.registration_requests.create_index([("email", 1), ("status", 1)])
    await db.organization_invitations.create_index("organization_id")
    await db.organization_invitations.create_index("email")
    await db.organization_invitations.create_index([("organization_id", 1), ("email", 1), ("status", 1)])
    await db.organization_invitations.create_index(
        [("organization_id", 1), ("email", 1)],
        unique=True,
        partialFilterExpression={"status": "pending"},
        name="uniq_pending_org_email",
    )
    await db[ORG_TOOL_POLICY_COLLECTION].create_index("organization_id", unique=True)
    await db[TOOL_EXECUTION_LOG_COLLECTION].create_index([("organization_id", 1), ("created_at", -1)])
    await db[TOOL_EXECUTION_LOG_COLLECTION].create_index(
        [("organization_id", 1), ("tool_name", 1), ("created_at", -1)],
    )
    await db[AGENT_CHAT_SESSIONS_COLLECTION].create_index(
        [("organization_id", 1), ("user_id", 1), ("updated_at", -1)],
    )
    await db[AGENT_CHAT_MESSAGES_COLLECTION].create_index([("session_id", 1), ("created_at", 1)])
    await db[AGENT_CHAT_MESSAGES_COLLECTION].create_index([("organization_id", 1), ("user_id", 1)])


async def close_db() -> None:
    if mongo.client:
        mongo.client.close()
        mongo.client = None
