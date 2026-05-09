export type WorkspaceToolsOverview = {
  server: {
    cipherstrike_api: string;
    agent_reachable: boolean;
    agent_status: string | null;
    agent_message: string | null;
    agent_version: string | null;
    agent_uptime_seconds: number | null;
  };
  /** Probe-style counts for tools allowed for this org (excludes org-disabled rows). */
  kali_tools: { available: number; total: number };
  /** Intelligence / AI / vuln-intel facet rows summed from category_stats. */
  server_tools: { available: number; total: number };
};

/** Per-field documentation merged from NyxStrike `arsenal_user_documentation.json` + registry defaults. */
export type ToolParameterDoc = {
  label?: string | null;
  help?: string | null;
  /** Where the value is expected to originate (e.g. request JSON vs host paths). */
  source?: string | null;
  value_type?: string | null;
  example?: string | null;
  required?: boolean | null;
  catalog_default?: unknown;
};

export type WorkspaceToolCard = {
  name: string;
  description: string;
  category: string;
  endpoint: string;
  method: string;
  active: boolean;
  health_bars: number;
  effectiveness: number | null;
  /** NyxStrike catalog `params` (required-parameter schema). */
  params: Record<string, unknown>;
  /** NyxStrike catalog `optional` (defaults for optional POST fields). */
  optional: Record<string, unknown>;
  /** Expanded narrative for modals and cards. */
  long_description?: string;
  usage?: string;
  safety?: string;
  /** Upstream / official documentation URL from the NyxStrike catalog (may be empty). */
  documentation_url?: string;
  parameter_documentation?: Record<string, ToolParameterDoc>;
};

export type WorkspaceToolsResponse = {
  overview: WorkspaceToolsOverview;
  categories: string[];
  tools: WorkspaceToolCard[];
  disabled_tools?: WorkspaceToolCard[];
};

/** Main catalog filter: allowed vs probe vs org-disabled (Tools workspace dropdown). */
export type ToolAvailabilityFilter =
  | "allowed_all"
  | "allowed_installed"
  | "allowed_not_installed"
  | "org_restricted";

