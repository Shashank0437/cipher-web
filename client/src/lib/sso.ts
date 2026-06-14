import { getApiBase } from "./env";

export type SsoDiscoverResult = {
  sso_available: boolean;
  sso_required: boolean;
  provider_display_name: string;
  domain: string;
};

export type RegistrationPreview = {
  email: string;
  username: string;
  company_name: string;
  sso_available: boolean;
  sso_required: boolean;
  provider_display_name: string;
};

export function buildSamlLoginUrl(params: {
  email: string;
  relay?: string;
  relayType?: "login" | "registration" | "invitation";
}): string {
  const base = getApiBase();
  const q = new URLSearchParams({ email: params.email.trim() });
  if (params.relay) q.set("relay", params.relay);
  if (params.relayType && params.relayType !== "login") q.set("relay_type", params.relayType);
  return `${base}/auth/saml/login?${q.toString()}`;
}
