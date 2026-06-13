import { ApiError, getToken } from "@/lib/api";
import { getApiBase } from "@/lib/env";

export type AttackChainPrecision = "quick" | "comprehensive" | "stealth";

export type AttackChainPlan = {
  id: string;
  title: string;
  badge: string;
  description: string;
  details: string;
  modal_description: string;
  tools: string[];
  placeholder: string;
  kind?: "fixed" | "intelligent";
};

export type AttackChainStepReason = {
  summary?: string;
  effective_score?: number;
  noise_score?: number;
  objective_match?: boolean;
  new_capabilities_added?: string[];
  covers_required?: string[];
};

export type AttackChainPhase = {
  phase: string;
  label: string;
  step_indices: number[];
};

export type AttackChainPlanPreview = {
  success: boolean;
  plan_id: string;
  session_name: string;
  target: string;
  target_type?: string | null;
  objective?: string | null;
  tools: string[];
  steps: Array<Record<string, unknown>>;
  risk_level?: string | null;
  estimated_time?: number | null;
  success_probability?: number | null;
  target_profile?: Record<string, unknown> | null;
  executive_summary?: string | null;
  attack_paths?: string[];
  attack_phases?: AttackChainPhase[];
  planner_source?: string | null;
  error?: string | null;
};

export type AttackChainFollowupPreview = {
  success: boolean;
  session_id?: string;
  target?: string;
  tools: string[];
  steps: Array<Record<string, unknown>>;
  executive_summary?: string | null;
  attack_paths?: string[];
  attack_phases?: AttackChainPhase[];
  planner_source?: string | null;
  already_generated?: boolean;
  error?: string | null;
  message?: string | null;
};

export type AttackChainFollowupAcceptResult = {
  success: boolean;
  attack_chain?: Record<string, unknown> | null;
  error?: string | null;
};

const PREFIX = "/workspace/agent-chat";

function bearerHeaders(json = false): Headers {
  const headers = new Headers();
  if (json) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function detailFromResponseBody(text: string, fallback: string): string {
  try {
    const j = JSON.parse(text) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) return JSON.stringify(j.detail);
  } catch {
    /* ignore */
  }
  return text.trim() || fallback;
}

export async function listAttackChainPlans(): Promise<AttackChainPlan[]> {
  const res = await fetch(`${getApiBase()}${PREFIX}/attack-chain-plans`, { headers: bearerHeaders() });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  const data = JSON.parse(text) as { plans: AttackChainPlan[] };
  return data.plans ?? [];
}

export async function previewAttackChainPlan(
  planId: string,
  target: string,
  options?: {
    objective?: AttackChainPrecision;
    operatorNote?: string;
  },
): Promise<AttackChainPlanPreview> {
  const res = await fetch(`${getApiBase()}${PREFIX}/attack-chain-plans/${encodeURIComponent(planId)}/preview`, {
    method: "POST",
    headers: bearerHeaders(true),
    body: JSON.stringify({
      target: target.trim(),
      objective: options?.objective ?? "comprehensive",
      operator_note: options?.operatorNote?.trim() ?? "",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as AttackChainPlanPreview;
}

export function stepSelectionReason(step: Record<string, unknown>): AttackChainStepReason | null {
  const raw = step.selection_reason;
  if (!raw || typeof raw !== "object") return null;
  return raw as AttackChainStepReason;
}

export function buildAttackChainPrompt(
  planTitle: string,
  target: string,
  tools: string[],
  note?: string,
  options?: { intelligent?: boolean; objective?: string },
): string {
  const toolList = tools.join(", ");
  const lines: string[] = [];
  if (options?.intelligent) {
    lines.push(
      `[Intelligent attack chain: ${planTitle}]`,
      `Target: ${target}.`,
      "Execute the AI-planned pipeline below in order.",
    );
  } else {
    lines.push(`[Attack chain: ${planTitle}]`, `Execute the full pipeline on ${target}.`);
  }
  lines.push(`Run these tools in order (respect dependencies): ${toolList}.`);
  lines.push("Call exactly one tool per turn; wait for each result before the next step.");
  if (note?.trim()) {
    lines.push(`Operator custom prompt: ${note.trim()}`);
  }
  return lines.join("\n");
}

export async function generateAttackChainFollowup(sessionId: string): Promise<AttackChainFollowupPreview> {
  const res = await fetch(
    `${getApiBase()}${PREFIX}/sessions/${encodeURIComponent(sessionId)}/attack-chain-followup`,
    { method: "POST", headers: bearerHeaders() },
  );
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as AttackChainFollowupPreview;
}

export async function acceptAttackChainFollowup(
  sessionId: string,
  body: {
    steps?: Array<Record<string, unknown>>;
    executiveSummary?: string;
    attackPhases?: AttackChainPhase[];
  },
): Promise<AttackChainFollowupAcceptResult> {
  const res = await fetch(
    `${getApiBase()}${PREFIX}/sessions/${encodeURIComponent(sessionId)}/attack-chain-followup/accept`,
    {
      method: "POST",
      headers: bearerHeaders(true),
      body: JSON.stringify({
        steps: body.steps ?? [],
        executive_summary: body.executiveSummary?.trim() ?? "",
        attack_phases: body.attackPhases ?? [],
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as AttackChainFollowupAcceptResult;
}
