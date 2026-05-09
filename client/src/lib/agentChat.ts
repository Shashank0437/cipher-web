import { ApiError, getToken } from "./api";
import { getApiBase } from "./env";

const PREFIX = "/workspace/agent-chat";

export type AgentChatSession = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type AgentChatToolCallState = {
  state?: string;
  tool_name?: string;
  arguments?: Record<string, unknown>;
  endpoint?: string;
  description?: string;
};

export type AgentChatBatchSlot = {
  slot_index?: number;
  human_decision?: string | null;
  tool_name?: string;
  arguments?: Record<string, unknown>;
  endpoint?: string;
  description?: string;
  execution_outcome?: string;
};

export type AgentChatMessage = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  tool_call?: AgentChatToolCallState | null;
  tool_calls?: AgentChatBatchSlot[] | null;
  batch_execution_state?: string | null;
  thinking_content?: string | null;
};

export type AgentChatToolExecutionMode = "ask_permission" | "auto_accept";

export type AgentChatOrgToolRow = {
  name: string;
  description: string;
};

export type AgentChatContextPayload = {
  page?: string;
  session_id?: string;
};

/** Parsed SSE payloads from POST …/messages and …/tool-confirm (CipherStrike agent chat). */
export type AgentChatSseEvent =
  | { type: "thinking" }
  | { type: "thinking_token"; text: string }
  | { type: "token"; text: string }
  | { type: "tool_pending"; payload: Record<string, unknown> }
  | { type: "tool_batch_pending"; payload: Record<string, unknown> }
  | { type: "done" }
  | { type: "error"; message: string };

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

export async function listAgentChatSessions(): Promise<AgentChatSession[]> {
  const res = await fetch(`${getApiBase()}${PREFIX}/sessions`, { headers: bearerHeaders() });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as AgentChatSession[];
}

export async function createAgentChatSession(title = ""): Promise<AgentChatSession> {
  const res = await fetch(`${getApiBase()}${PREFIX}/sessions`, {
    method: "POST",
    headers: bearerHeaders(true),
    body: JSON.stringify({ title }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as AgentChatSession;
}

export async function deleteAgentChatSession(sessionId: string): Promise<void> {
  const res = await fetch(`${getApiBase()}${PREFIX}/sessions/${sessionId}`, {
    method: "DELETE",
    headers: bearerHeaders(),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
}

export async function listAgentChatMessages(sessionId: string): Promise<AgentChatMessage[]> {
  const res = await fetch(`${getApiBase()}${PREFIX}/sessions/${sessionId}/messages`, {
    headers: bearerHeaders(),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as AgentChatMessage[];
}

export async function fetchAgentChatOrgTools(): Promise<AgentChatOrgToolRow[]> {
  const res = await fetch(`${getApiBase()}${PREFIX}/org-tools`, { headers: bearerHeaders() });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  const j = JSON.parse(text) as { tools?: AgentChatOrgToolRow[] };
  return Array.isArray(j.tools) ? j.tools : [];
}

/** Concatenate `data:` lines for one SSE event block (per HTML Standard). */
export function sseBlockToData(block: string): string {
  const lines = block.split("\n");
  const parts: string[] = [];
  for (const ln of lines) {
    if (ln.startsWith("data:")) {
      parts.push(ln.slice(5).trimStart());
    }
  }
  return parts.join("\n");
}

export function parseAgentChatSsePayload(payload: string): AgentChatSseEvent | null {
  const p = payload.trim();
  if (!p) return null;
  if (p.startsWith("[THINK_TOKEN]")) {
    const rest = p.slice("[THINK_TOKEN]".length).trim();
    try {
      const tok = JSON.parse(rest);
      if (typeof tok === "string") return { type: "thinking_token", text: tok };
    } catch {
      /* fall through */
    }
    return { type: "thinking_token", text: rest };
  }
  if (p === "[THINKING]" || p.startsWith("[THINKING]")) return { type: "thinking" };
  if (p === "[DONE]") return { type: "done" };
  if (p.startsWith("[ERROR]")) return { type: "error", message: p.slice(7).trimStart() };
  if (p.startsWith("[TOOL_CALL_PENDING]")) {
    const rest = p.slice("[TOOL_CALL_PENDING]".length).trim();
    try {
      const obj = JSON.parse(rest) as Record<string, unknown>;
      return { type: "tool_pending", payload: obj };
    } catch {
      return { type: "tool_pending", payload: {} };
    }
  }
  if (p.startsWith("[TOOL_CALL_BATCH_PENDING]")) {
    const rest = p.slice("[TOOL_CALL_BATCH_PENDING]".length).trim();
    try {
      const obj = JSON.parse(rest) as Record<string, unknown>;
      return { type: "tool_batch_pending", payload: obj };
    } catch {
      return { type: "tool_batch_pending", payload: {} };
    }
  }
  try {
    const tok = JSON.parse(p);
    if (typeof tok === "string") return { type: "token", text: tok };
  } catch {
    /* ignore */
  }
  return null;
}

/** Break React's automatic batching so token/thinking deltas paint progressively (not one lump per TCP chunk). */
function yieldUiTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function dispatchSseEvent(ev: AgentChatSseEvent, onEvent: (ev: AgentChatSseEvent) => void): Promise<void> {
  onEvent(ev);
  if (ev.type === "token" || ev.type === "thinking_token") {
    await yieldUiTurn();
  }
}

async function consumeSse(
  res: Response,
  onEvent: (ev: AgentChatSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames end with blank line; normalize CRLF so ``\r\n\r\n`` splits like ``\n\n``.
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const rawBlock = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = sseBlockToData(rawBlock);
      if (data) {
        const ev = parseAgentChatSsePayload(data);
        if (ev) await dispatchSseEvent(ev, onEvent);
      }
      sep = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    const data = sseBlockToData(buffer);
    if (data) {
      const ev = parseAgentChatSsePayload(data);
      if (ev) await dispatchSseEvent(ev, onEvent);
    }
  }
}

async function postSse(
  path: string,
  jsonBody: unknown,
  onEvent: (ev: AgentChatSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  /** Do not bump global API pending — long SSE streams would show the full-screen "Loading workspace…" overlay. */
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: bearerHeaders(true),
    body: JSON.stringify(jsonBody),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  }
  await consumeSse(res, onEvent, signal);
}

async function postSseEmptyBody(
  path: string,
  onEvent: (ev: AgentChatSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: bearerHeaders(),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  }
  await consumeSse(res, onEvent, signal);
}

/** Stream assistant response for a new user message (persists user row server-side). */
export async function streamAgentChatMessage(
  sessionId: string,
  message: string,
  options?: {
    context?: AgentChatContextPayload;
    toolExecutionMode?: AgentChatToolExecutionMode;
    explicitToolNames?: string[] | null;
    onEvent?: (ev: AgentChatSseEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const body: {
    message: string;
    context?: AgentChatContextPayload;
    tool_execution_mode?: AgentChatToolExecutionMode;
    explicit_tool_names?: string[];
  } = {
    message: message.trim(),
  };
  if (options?.context && (options.context.page || options.context.session_id)) {
    body.context = options.context;
  }
  if (options?.toolExecutionMode && options.toolExecutionMode !== "ask_permission") {
    body.tool_execution_mode = options.toolExecutionMode;
  }
  if (options?.explicitToolNames?.length) {
    body.explicit_tool_names = options.explicitToolNames.slice(0, 24);
  }
  await postSse(
    `${PREFIX}/sessions/${sessionId}/messages`,
    body,
    options?.onEvent ?? (() => {}),
    options?.signal,
  );
}

/** Approve or reject a pending tool call and stream any follow-up assistant reply. */
export async function streamAgentChatToolConfirm(
  sessionId: string,
  assistantMessageId: string,
  approved: boolean,
  options?: {
    onEvent?: (ev: AgentChatSseEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  await postSse(
    `${PREFIX}/sessions/${sessionId}/tool-confirm`,
    { approved, assistant_message_id: assistantMessageId },
    options?.onEvent ?? (() => {}),
    options?.signal,
  );
}

/** Merge approve/reject choices for a pending tool batch (quorum = every slot decided). */
export async function patchAgentChatToolBatchDecisions(
  sessionId: string,
  messageId: string,
  decisions: Record<string, string>,
): Promise<{ quorum_met: boolean; decided: number; total: number }> {
  const res = await fetch(`${getApiBase()}${PREFIX}/sessions/${sessionId}/messages/${messageId}/tool-decisions`, {
    method: "PATCH",
    headers: bearerHeaders(true),
    body: JSON.stringify({ decisions }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(detailFromResponseBody(text, res.statusText), res.status, text);
  return JSON.parse(text) as { quorum_met: boolean; decided: number; total: number };
}

/** After quorum, run approved tools in parallel and stream follow-up assistant reply. */
export async function streamAgentChatToolBatchExecute(
  sessionId: string,
  assistantMessageId: string,
  options?: {
    onEvent?: (ev: AgentChatSseEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  await postSseEmptyBody(
    `${PREFIX}/sessions/${sessionId}/messages/${assistantMessageId}/tool-batch-execute`,
    options?.onEvent ?? (() => {}),
    options?.signal,
  );
}
