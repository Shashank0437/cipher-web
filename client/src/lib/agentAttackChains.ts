import { ApiError, getToken } from "@/lib/api";
import { getApiBase } from "@/lib/env";

export type AttackChainPlan = {
  id: string;
  title: string;
  badge: string;
  description: string;
  details: string;
  modal_description: string;
  tools: string[];
  placeholder: string;
};

export type AttackChainPlanPreview = {
  success: boolean;
  plan_id: string;
  session_name: string;
  target: string;
  target_type?: string | null;
  tools: string[];
  steps: Array<Record<string, unknown>>;
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

export async function previewAttackChainPlan(planId: string, target: string): Promise<AttackChainPlanPreview> {
  const res = await fetch(`${getApiBase()}${PREFIX}/attack-chain-plans/${encodeURIComponent(planId)}/preview`, {
    method: "POST",
    headers: bearerHeaders(true),
    body: JSON.stringify({ target: target.trim() }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as AttackChainPlanPreview;
}

export function buildAttackChainPrompt(
  planTitle: string,
  target: string,
  tools: string[],
  note?: string,
): string {
  const toolList = tools.join(", ");
  const lines = [
    `[Attack chain: ${planTitle}]`,
    `Execute the full pipeline on ${target}.`,
    `Run these tools in order (respect dependencies): ${toolList}.`,
    "Call exactly one tool per turn; wait for each result before the next step.",
  ];
  if (note?.trim()) {
    lines.push(`Operator note: ${note.trim()}`);
  }
  return lines.join("\n");
}
