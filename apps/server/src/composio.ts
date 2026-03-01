import { randomUUID } from "node:crypto";
import { Composio, type Tool } from "@composio/core";

import type { EnvConfig } from "./env.js";
import { CircuitBreaker, isRetriableError, withRetries } from "./reliability.js";

export type ComposioCatalogItem = {
  authConfigId: string;
  name: string;
  toolkitSlug: string;
  toolkitName: string;
  authScheme: string | null;
  isComposioManaged: boolean;
};

export type ComposioConnection = {
  connectedAccountId: string;
  authConfigId: string | null;
  authConfigName: string | null;
  toolkitSlug: string;
  toolkitName: string;
  status: string;
};

export type AgentToolDefinition = {
  toolName: string;
  toolSlug: string;
  description: string;
  toolkitSlug: string | null;
  inputSchema: Record<string, unknown>;
  connectedAccountId: string | null;
  connectedAccountIds: string[];
  isMutating: boolean;
};

type ToolByName = Record<string, AgentToolDefinition>;

export class ComposioService {
  private readonly client: Composio | null;
  private readonly breaker: CircuitBreaker;

  constructor(private readonly env: EnvConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: env.providerCircuitBreakerFailures,
      cooldownMs: env.providerCircuitBreakerCooldownMs
    });
    if (!env.composioApiKey) {
      this.client = null;
      return;
    }

    this.client = new Composio({
      apiKey: env.composioApiKey,
      baseURL: env.composioBaseUrl
    });
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async listCatalog(): Promise<ComposioCatalogItem[]> {
    if (!this.client) {
      return [];
    }

    const response = await this.runWithResilience(() => this.client!.authConfigs.list());
    const items = asArray((response as { items?: unknown[] }).items);
    const authConfigCatalog = items
      .map((item) => asCatalogItem(item))
      .filter((item): item is ComposioCatalogItem => item !== null)
      .sort((a, b) => a.toolkitName.localeCompare(b.toolkitName));

    if (authConfigCatalog.length > 0) {
      return authConfigCatalog;
    }

    // Fallback: workspace may rely on managed toolkit authorization without explicit auth configs.
    const toolkitsResponse = await this.runWithResilience(() => (this.client!.toolkits as any).getToolkits({ limit: 400 }));
    const toolkitItems = asArray(toolkitsResponse);
    return toolkitItems
      .map((item) => asToolkitCatalogItem(item))
      .filter((item): item is ComposioCatalogItem => item !== null)
      .sort((a, b) => a.toolkitName.localeCompare(b.toolkitName));
  }

  async createConnectLink(
    composioUserId: string,
    authConfigId: string
  ): Promise<{ redirectUrl: string; connectionRequestId: string }> {
    if (!this.client) {
      throw new Error("Composio is not configured.");
    }

    if (authConfigId.startsWith("toolkit:")) {
      const toolkitSlug = authConfigId.slice("toolkit:".length).trim();
      if (!toolkitSlug) {
        throw new Error("Invalid toolkit connection identifier.");
      }

      const toolkitRequest = await this.runWithResilience(() =>
        this.client!.toolkits.authorize(composioUserId, toolkitSlug)
      );
      const toolkitRedirectUrl = readStringValue(toolkitRequest, "redirectUrl");
      if (!toolkitRedirectUrl) {
        throw new Error("Composio toolkit authorization did not return a redirect URL.");
      }

      return {
        redirectUrl: toolkitRedirectUrl,
        connectionRequestId: readStringValue(toolkitRequest, "id") ?? randomUUID()
      };
    }

    const request = await this.runWithResilience(() =>
      this.client!.connectedAccounts.link(composioUserId, authConfigId, {
        callbackUrl: this.env.composioConnectCallbackUrl
      })
    );

    const redirectUrl = readStringValue(request, "redirectUrl");
    if (!redirectUrl) {
      throw new Error("Composio did not return a redirect URL.");
    }

    return {
      redirectUrl,
      connectionRequestId: readStringValue(request, "id") ?? randomUUID()
    };
  }

  async waitForConnection(connectedAccountId: string): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.runWithResilience(() => this.client!.connectedAccounts.waitForConnection(connectedAccountId, 60_000));
  }

  async listConnections(composioUserId: string): Promise<ComposioConnection[]> {
    if (!this.client) {
      return [];
    }

    const response = await this.runWithResilience(() =>
      this.client!.connectedAccounts.list({ userIds: [composioUserId] } as never)
    );
    const items = asArray((response as { items?: unknown[] }).items);

    return items
      .map((item) => asConnection(item))
      .filter((item): item is ComposioConnection => item !== null)
      .sort((a, b) => a.toolkitName.localeCompare(b.toolkitName));
  }

  async listToolsByUser(composioUserId: string): Promise<ToolByName> {
    if (!this.client) {
      return {};
    }

    const connections = await this.listConnections(composioUserId);
    const activeByToolkit = new Map<string, string[]>();
    for (const connection of connections) {
      if (connection.status.toUpperCase() !== "ACTIVE") {
        continue;
      }
      const existing = activeByToolkit.get(connection.toolkitSlug) ?? [];
      if (!existing.includes(connection.connectedAccountId)) {
        existing.push(connection.connectedAccountId);
      }
      activeByToolkit.set(connection.toolkitSlug, existing);
    }

    const toolkitSlugs = Array.from(activeByToolkit.keys());
    if (toolkitSlugs.length === 0) {
      return {};
    }

    const rawTools = await this.runWithResilience(() =>
      this.client!.tools.getRawComposioTools({
        toolkits: toolkitSlugs,
        limit: 400
      })
    );

    const toolItems = Array.isArray(rawTools) ? rawTools : asArray((rawTools as { items?: unknown[] }).items);
    const definitions: ToolByName = {};
    for (const item of toolItems) {
      const tool = item as Tool;
      const toolName = normalizeToolName(tool.slug);
      definitions[toolName] = {
        toolName,
        toolSlug: tool.slug,
        description: tool.description ?? `${tool.name}.`,
        toolkitSlug: tool.toolkit?.slug ?? null,
        inputSchema: ensureSchema(tool.inputParameters),
        connectedAccountId: tool.toolkit?.slug ? (activeByToolkit.get(tool.toolkit.slug) ?? [])[0] ?? null : null,
        connectedAccountIds: tool.toolkit?.slug ? activeByToolkit.get(tool.toolkit.slug) ?? [] : [],
        isMutating: classifyToolMutability(tool)
      };
    }

    return definitions;
  }

  async executeTool(
    composioUserId: string,
    tool: AgentToolDefinition,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error("Composio is not configured.");
    }

    const candidateAccountIds = dedupeConnectedAccountIds(tool.connectedAccountId, tool.connectedAccountIds);

    if (candidateAccountIds.length <= 1 || tool.isMutating) {
      return this.runExecute(tool.toolSlug, composioUserId, candidateAccountIds[0] ?? null, args);
    }

    let lastError: unknown = null;
    for (const connectedAccountId of candidateAccountIds) {
      try {
        return await this.runExecute(tool.toolSlug, composioUserId, connectedAccountId, args);
      } catch (error) {
        lastError = error;
      }
    }

    const fallbackMessage = toErrorMessage(lastError);
    throw new Error(`Tool ${tool.toolSlug} failed for all connected accounts: ${fallbackMessage}`);
  }

  private async runExecute(
    toolSlug: string,
    composioUserId: string,
    connectedAccountId: string | null,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error("Composio is not configured.");
    }

    return this.runWithResilience(() =>
      this.client!.tools.execute(toolSlug, {
        userId: composioUserId,
        connectedAccountId: connectedAccountId ?? undefined,
        arguments: args,
        dangerouslySkipVersionCheck: true
      })
    );
  }

  private async runWithResilience<T>(operation: () => Promise<T>): Promise<T> {
    return this.breaker.execute(() =>
      withRetries(operation, {
        retries: this.env.providerMaxRetries,
        shouldRetry: isRetriableError
      })
    );
  }
}

export function normalizeToolName(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function classifyToolMutability(tool: Pick<Tool, "slug" | "tags">): boolean {
  const tags = (tool.tags ?? []).map((tag) => tag.toLowerCase());
  if (tags.includes("readonlyhint") || tags.includes("read_only")) {
    return false;
  }
  if (tags.includes("destructivehint")) {
    return true;
  }

  const slug = tool.slug.toLowerCase();
  if (
    /(create|update|upsert|delete|remove|send|post|write|set|append|add|modify|close|archive|invite|assign|patch)/.test(
      slug
    )
  ) {
    return true;
  }
  if (/(get|list|search|find|fetch|read|retrieve|query|view|download|preview)/.test(slug)) {
    return false;
  }
  return true;
}

function ensureSchema(inputSchema: unknown): Record<string, unknown> {
  const schema = (inputSchema ?? null) as Record<string, unknown> | null;
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true
    };
  }
  return schema;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asCatalogItem(raw: unknown): ComposioCatalogItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const toolkit = readObject(item, "toolkit");
  const authConfigId = readStringValue(item, "id");
  const toolkitSlug = readStringValue(toolkit, "slug");
  if (!authConfigId || !toolkitSlug) {
    return null;
  }
  const toolkitName = readStringValue(toolkit, "name") ?? humanizeToolkitSlug(toolkitSlug);

  return {
    authConfigId,
    name: readStringValue(item, "name") ?? `${toolkitName} Connection`,
    toolkitSlug,
    toolkitName,
    authScheme: readStringValue(item, "authScheme") ?? readStringValue(item, "authSchemeType"),
    isComposioManaged: readBooleanValue(item, "isComposioManaged") ?? false
  };
}

function asToolkitCatalogItem(raw: unknown): ComposioCatalogItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const toolkitSlug = readStringValue(item, "slug");
  const toolkitName = readStringValue(item, "name");
  const noAuth = readBooleanValue(item, "noAuth");
  if (!toolkitSlug || !toolkitName || noAuth) {
    return null;
  }

  const composioManagedSchemes = asStringArray(item.composioManagedAuthSchemes);
  const authSchemes = asStringArray(item.authSchemes);
  const scheme = composioManagedSchemes[0] ?? authSchemes[0] ?? null;

  return {
    authConfigId: `toolkit:${toolkitSlug}`,
    name: `${toolkitName} Managed Connection`,
    toolkitSlug,
    toolkitName,
    authScheme: scheme,
    isComposioManaged: true
  };
}

function asConnection(raw: unknown): ComposioConnection | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const toolkit = readObject(item, "toolkit");
  const authConfig = readObject(item, "authConfig");
  const data = readObject(item, "data");
  const state = readObject(item, "state");
  const stateValue = readObject(state, "val");
  const connectedAccountId =
    readStringValue(item, "id") ?? readStringValue(item, "nanoid") ?? readStringValue(item, "connectedAccountId");
  const toolkitSlug = readStringValue(toolkit, "slug");
  const toolkitName = readStringValue(toolkit, "name") ?? (toolkitSlug ? humanizeToolkitSlug(toolkitSlug) : null);

  if (!connectedAccountId || !toolkitSlug || !toolkitName) {
    return null;
  }

  const status =
    readStringValue(item, "status") ??
    readStringValue(data, "status") ??
    readStringValue(stateValue, "status") ??
    "UNKNOWN";

  return {
    connectedAccountId,
    authConfigId: readStringValue(authConfig, "id") ?? readStringValue(item, "authConfigId"),
    authConfigName: readStringValue(authConfig, "name"),
    toolkitSlug,
    toolkitName,
    status
  };
}

function readObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readStringValue(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBooleanValue(source: unknown, key: string): boolean | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

function humanizeToolkitSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function dedupeConnectedAccountIds(primary: string | null, extra: string[]): string[] {
  const unique = new Set<string>();
  if (primary) {
    unique.add(primary);
  }
  for (const connectedAccountId of extra) {
    if (connectedAccountId && connectedAccountId.length > 0) {
      unique.add(connectedAccountId);
    }
  }
  return Array.from(unique);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
