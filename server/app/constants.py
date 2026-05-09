"""Shared constants for Redis keys."""

REG_COMPLETE_REDIS_PREFIX = "cipherstrike:reg_complete:"
ORG_INVITE_REDIS_PREFIX = "cipherstrike:org_invite:"

ORG_TOOL_POLICY_COLLECTION = "organization_tool_policy"
TOOL_EXECUTION_LOG_COLLECTION = "tool_execution_log"

MAX_TOOL_RUN_REQUEST_SNAPSHOT = 32 * 1024
MAX_TOOL_RUN_RESPONSE_RAW = 64 * 1024
MAX_TOOL_RUN_STDOUT_STORE = 32 * 1024
MAX_TOOL_RUN_STDERR_STORE = 32 * 1024
