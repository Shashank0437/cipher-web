from pydantic import BaseModel, Field


class OrgToolPolicyOut(BaseModel):
    disabled_tool_names: list[str] = Field(default_factory=list)


class PatchToolEnabledIn(BaseModel):
    tool_name: str = Field(min_length=1)
    enabled: bool
