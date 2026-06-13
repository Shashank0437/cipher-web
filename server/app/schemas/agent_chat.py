"""Pydantic models for Mongo-backed agent chat (CipherStrike API)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class AgentChatContext(BaseModel):
    page: str = ""
    session_id: str = ""


class AgentChatSessionCreate(BaseModel):
    title: str = ""


class AgentChatSessionPatch(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)


class AgentChatSessionOut(BaseModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    input_tokens: int = 0
    output_tokens: int = 0
    num_calls: int = 0
    executed_by: str | None = None


class AgentChatSessionIntelligenceOut(BaseModel):
    session_id: str
    title: str
    status: Literal["IN_PROGRESS", "COMPLETED", "FAILED"]
    summary: str
    average_time_to_breach: str
    average_time_to_breach_seconds: int = 0
    total_scans: int = 1
    findings_count: dict[str, int]
    findings: list[dict[str, Any]]
    tools_used: list[str]
    timeline: list[dict[str, Any]]
    targets: list[str]
    started_at: str
    updated_at: str
    completed_at: str | None = None
    replay_metadata: dict[str, Any] = Field(default_factory=dict)
    report_metadata: dict[str, Any] = Field(default_factory=dict)
    executed_by: str | None = None


class AgentChatOrgToolRow(BaseModel):
    """Tool enabled for agent chat for this org, reported installed on the agent host (not org-disabled, not chat-blocklisted)."""

    name: str
    description: str = ""


class AgentChatOrgToolsOut(BaseModel):
    tools: list[AgentChatOrgToolRow]


class AgentChatAttachmentOut(BaseModel):
    id: str
    filename: str
    content_type: str = "application/pdf"


class AgentChatMessageOut(BaseModel):
    id: str
    role: str
    content: str
    created_at: datetime
    tool_call: dict[str, Any] | None = None
    tool_calls: list[dict[str, Any]] | None = None
    batch_execution_state: str | None = None
    thinking_content: str | None = None
    router_category: str | None = None
    keyword_category: str | None = None
    keyword_confidence: float | None = None
    attachments: list[AgentChatAttachmentOut] | None = None


class AgentChatToolDecisionsPatch(BaseModel):
    decisions: dict[str, str] = Field(..., description='Slot index string → "approve" or "reject"')


class AgentChatSendBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=32000)
    context: AgentChatContext | None = None
    tool_execution_mode: Literal["ask_permission", "auto_accept"] = "ask_permission"
    explicit_tool_names: list[str] = Field(
        default_factory=list,
        max_length=24,
        description="If non-empty, skip route-intent and bind LLM tool schemas to this subset (must be org-enabled).",
    )
    attack_chain_steps: list[dict[str, Any]] = Field(
        default_factory=list,
        max_length=32,
        description="Ordered workflow_steps from attack-chain preview; enables sequential tool execution.",
    )
    attack_chain_plan_id: str = Field(default="", max_length=64)
    attack_chain_objective: str = Field(default="", max_length=32)
    attack_chain_operator_note: str = Field(default="", max_length=4000)
    attack_chain_executive_summary: str = Field(default="", max_length=8000)
    attack_chain_paths: list[str] = Field(default_factory=list, max_length=8)
    attack_chain_phases: list[dict[str, Any]] = Field(default_factory=list, max_length=16)
    attack_chain_planner_source: str = Field(default="", max_length=32)


class AgentChatToolConfirmBody(BaseModel):
    approved: bool
    assistant_message_id: str


class AttackChainPlanOut(BaseModel):
    id: str
    title: str
    badge: str
    description: str
    details: str
    modal_description: str
    tools: list[str]
    placeholder: str
    kind: Literal["fixed", "intelligent"] = "fixed"


class AttackChainPlansOut(BaseModel):
    plans: list[AttackChainPlanOut]


class AttackChainPlanPreviewBody(BaseModel):
    target: str = Field(..., min_length=1, max_length=500)
    objective: Literal["quick", "comprehensive", "stealth"] = "comprehensive"
    operator_note: str = Field(default="", max_length=4000)


class AttackChainPlanPreviewOut(BaseModel):
    success: bool
    plan_id: str = ""
    session_name: str = ""
    target: str = ""
    target_type: str | None = None
    objective: str | None = None
    tools: list[str] = Field(default_factory=list)
    steps: list[dict[str, Any]] = Field(default_factory=list)
    risk_level: str | None = None
    estimated_time: int | None = None
    success_probability: float | None = None
    target_profile: dict[str, Any] | None = None
    executive_summary: str | None = None
    attack_paths: list[str] = Field(default_factory=list)
    attack_phases: list[dict[str, Any]] = Field(default_factory=list)
    planner_source: str | None = None
    error: str | None = None
