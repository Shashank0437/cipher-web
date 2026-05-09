/** Catalog-driven workspace tool run form helpers (aligned with NyxStrike `tool_registry.py` shapes). */

import type { ToolParameterDoc } from "@/components/tools/types";

export type FieldKind = "string" | "boolean" | "number";

export type ToolFormField = {
  key: string;
  required: boolean;
  kind: FieldKind;
  defaultValue: unknown;
  docs?: ToolParameterDoc | null;
};

function isParamMeta(v: unknown): v is { required?: boolean } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "required" in (v as object);
}

function inferKind(v: unknown): FieldKind {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number" && Number.isFinite(v)) return "number";
  return "string";
}

function kindFromDoc(valueType: string | null | undefined): FieldKind | null {
  if (!valueType) return null;
  if (valueType === "boolean") return "boolean";
  if (valueType === "number") return "number";
  return null;
}

function initialBool(defaultValue: unknown): string {
  if (defaultValue === true || defaultValue === "true" || defaultValue === 1) return "true";
  return "false";
}

export function catalogFieldsToFormRows(
  params: Record<string, unknown> | undefined,
  optional: Record<string, unknown> | undefined,
  parameterDocumentation?: Record<string, ToolParameterDoc> | null,
): ToolFormField[] {
  const rows: ToolFormField[] = [];
  const seen = new Set<string>();
  const p = params ?? {};
  const o = optional ?? {};
  const docMap = parameterDocumentation ?? {};

  for (const [key, raw] of Object.entries(p)) {
    if (!isParamMeta(raw)) continue;
    seen.add(key);
    const req = Boolean((raw as { required?: boolean }).required);
    const doc = docMap[key] ?? null;
    const kind = kindFromDoc(doc?.value_type ?? undefined) ?? "string";
    rows.push({ key, required: req, kind, defaultValue: "", docs: doc });
  }

  for (const [key, defVal] of Object.entries(o)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = docMap[key] ?? null;
    const kdoc = kindFromDoc(doc?.value_type ?? undefined);
    rows.push({
      key,
      required: false,
      kind: kdoc ?? inferKind(defVal),
      defaultValue: defVal,
      docs: doc,
    });
  }

  return rows.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

export function buildInitialStringValues(fields: ToolFormField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.kind === "boolean") {
      out[f.key] = initialBool(f.defaultValue);
    } else if (f.kind === "number") {
      out[f.key] = f.defaultValue === undefined || f.defaultValue === null ? "" : String(f.defaultValue);
    } else {
      out[f.key] = f.defaultValue === undefined || f.defaultValue === null ? "" : String(f.defaultValue);
    }
  }
  return out;
}

export function validateRequired(fields: ToolFormField[], values: Record<string, string>): string | null {
  for (const f of fields) {
    if (!f.required) continue;
    const raw = values[f.key];
    if (raw === undefined || raw.trim() === "") {
      return `Field «${f.key}» is required`;
    }
  }
  return null;
}

export function coerceRunPayload(fields: ToolFormField[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.key] ?? "";
    switch (f.kind) {
      case "boolean":
        out[f.key] = raw === "true";
        break;
      case "number": {
        const t = raw.trim();
        if (t === "" && !f.required) break;
        if (t === "" && f.required) {
          out[f.key] = 0;
          break;
        }
        const n = Number(t);
        out[f.key] = Number.isFinite(n) ? n : raw;
        break;
      }
      default: {
        if (raw.trim() === "" && !f.required) break;
        out[f.key] = raw;
        break;
      }
    }
  }
  return out;
}

export function formatSourceBadge(source: string | null | undefined): string | null {
  if (!source || !source.trim()) return null;
  const s = source.trim();
  const map: Record<string, string> = {
    request_json_body: "Form → JSON POST body",
    request_json_secrets: "Secret / credential (JSON)",
    agent_local_path_or_reference: "Agent host path",
    request_json_sensitive: "Sensitive HTTP field",
  };
  return map[s] ?? s.replace(/_/g, " ");
}

/** Avoid repeating the curated URL inline when we render a prominent docs link. */
export function stripEmbeddedAuthoritativeReference(description: string, docUrl: string | undefined): string {
  const t = description.trim();
  const url = docUrl?.trim();
  if (!url) return t;
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.replace(new RegExp(`\\s*Authoritative reference:\\s*${escaped}\\.?`, "i"), "").trim();
}

export function formatDefaultForDisplay(kind: FieldKind, valueType: string | undefined, raw: string): string {
  if (kind === "boolean" || valueType === "boolean") return raw;
  if (kind === "number") return raw;
  return `'${raw}'`;
}

export function fieldLabel(field: ToolFormField): string {
  const lbl = field.docs?.label?.trim();
  if (lbl) return lbl;
  return field.key.replace(/_/g, " ");
}

export function formatToolCategoryLabel(cat: string): string {
  return cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
