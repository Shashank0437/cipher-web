import { ApiError, getToken } from "@/lib/api";
import { getApiBase } from "@/lib/env";

export type SpecialistPreset = {
  value: string;
  label: string;
};

export type SpecialistAgentPlan = {
  id: string;
  title: string;
  badge: string;
  description: string;
  modal_description: string;
  specialist_count: number;
  featured?: boolean;
  placeholder_target: string;
  placeholder_goal?: string;
  presets: SpecialistPreset[];
  default_preset: string;
  fields: string[];
};

export type SpecialistAgentParams = Record<string, string>;

const PREFIX = "/workspace/agent-chat";

function bearerHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchSpecialistAgents(): Promise<SpecialistAgentPlan[]> {
  const res = await fetch(`${getApiBase()}${PREFIX}/specialist-agents`, { headers: bearerHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(text || res.statusText, res.status, text);
  }
  const data = (await res.json()) as { agents: SpecialistAgentPlan[] };
  return data.agents ?? [];
}

export function buildSpecialistInvocation(agentId: string, params: SpecialistAgentParams): string {
  const p = Object.fromEntries(
    Object.entries(params)
      .map(([k, v]) => [k, (v ?? "").trim()])
      .filter(([, v]) => v),
  );
  if (agentId === "htb-ctf") {
    const parts = [`target: ${p.target ?? ""}`, `goal: ${p.goal ?? ""}`];
    if (p.preset) parts.push(`preset: ${p.preset}`);
    if (p.notes) parts.push(`notes: ${p.notes}`);
    return parts.join(", ");
  }
  if (agentId === "bugbounty") {
    const parts = [
      `program: ${p.program ?? ""}`,
      `target: ${p.target ?? ""}`,
      `scope: ${p.scope ?? ""}`,
      `out_of_scope: ${p.out_of_scope ?? ""}`,
      `goal: ${p.goal ?? ""}`,
    ];
    if (p.preset) parts.push(`preset: ${p.preset}`);
    if (p.notes) parts.push(`notes: ${p.notes}`);
    return parts.join(", ");
  }
  const parts = [`target: ${p.target ?? ""}`];
  if (p.type) parts.push(`type: ${p.type}`);
  if (p.notes) parts.push(`notes: ${p.notes}`);
  return parts.join(", ");
}
