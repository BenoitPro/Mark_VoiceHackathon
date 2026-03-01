const DEFAULT_API_BASE_URL = "http://localhost:4000";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, "");
}

export function normalizeApiBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_API_BASE_URL;
  return trimTrailingSlashes(value);
}

export function buildApiUrl(baseUrl: string, path: string): string {
  return `${normalizeApiBaseUrl(baseUrl)}/${trimLeadingSlashes(path)}`;
}

export function buildSocketNamespaceUrl(baseUrl: string, namespace: string): string {
  return `${normalizeApiBaseUrl(baseUrl)}/${trimLeadingSlashes(namespace)}`;
}
