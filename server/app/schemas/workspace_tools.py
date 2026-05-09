from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class KaliToolsSummary(BaseModel):
    """Matches agent GET /health: total_tools_available and total_tools_count."""

    available: int
    total: int


class ServerToolsSummary(BaseModel):
    """Intelligence / API-style tooling slice."""

    available: int
    total: int


class WorkspaceServerStatus(BaseModel):
    cipherstrike_api: str = Field(default="ok", description="CipherStrike FastAPI surface status")
    agent_reachable: bool
    agent_status: str | None = None
    agent_message: str | None = None
    agent_version: str | None = None
    agent_uptime_seconds: float | None = None


class WorkspaceToolsOverview(BaseModel):
    server: WorkspaceServerStatus
    kali_tools: KaliToolsSummary
    server_tools: ServerToolsSummary


class WorkspaceToolCard(BaseModel):
    name: str
    description: str
    category: str
    endpoint: str
    method: str
    active: bool
    health_bars: int = Field(ge=1, le=5)
    effectiveness: float | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    optional: dict[str, Any] = Field(default_factory=dict)
    long_description: str = ""
    usage: str = ""
    safety: str = ""
    documentation_url: str = Field(
        default="",
        description="Curated upstream docs URL from NyxStrike tool_web_sources (empty for CipherStrike-only tools).",
    )
    parameter_documentation: dict[str, Any] = Field(
        default_factory=dict,
        description="Per-field docs merged from NyxStrike generated catalog overlays (label/help/source/value_type/example).",
    )


class WorkspaceToolsPayload(BaseModel):
    overview: WorkspaceToolsOverview
    categories: list[str]
    tools: list[WorkspaceToolCard]
    disabled_tools: list[WorkspaceToolCard] = Field(
        default_factory=list,
        description="Catalog rows denied for this org; tenant admins may restore access.",
    )


class WorkspaceToolRunRequest(BaseModel):
    """Proxy body: POST agent route with catalog JSON (+ optional Bearer from server config)."""

    tool_name: str = Field(min_length=1, description="Catalog tool key; checked against org policy.")
    endpoint: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ToolExecutionLogOut(BaseModel):
    id: str
    tool_name: str
    created_at: datetime
    agent_status_code: int
    success: bool | None = None
    execution_time: float | None = None
    return_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    endpoint: str = ""
    request_payload: dict[str, Any] = Field(
        default_factory=dict,
        description="Truncated snapshot of the POST body sent to the agent for this run.",
    )
    response_snippet: str = Field(
        default="",
        description="Raw or full JSON response body (when stdout/stderr are not used by the tool).",
    )


class ToolExecutionHistoryPage(BaseModel):
    """Paginated tool execution log for workspace history UI."""

    items: list[ToolExecutionLogOut]
    total: int = Field(ge=0, description="Total matching rows for this org (and tool filter).")
    limit: int = Field(ge=1, le=100, description="Page size applied on the server.")
    offset: int = Field(ge=0, description="Number of newest-first rows skipped.")

