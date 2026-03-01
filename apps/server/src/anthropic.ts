import type { EnvConfig } from "./env.js";

type Turn = {
  role: "user" | "assistant";
  content: string;
};

export type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicToolProposal = {
  toolName: string;
  args: Record<string, unknown>;
  assistantPreface: string;
  summary: string;
};

type GenerateReplyWithToolsParams = {
  sessionId: string;
  userText: string;
  tools: AnthropicToolDefinition[];
  executeReadTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  isMutatingTool: (toolName: string) => boolean;
  onPartial: (text: string) => void;
};

type GenerateReplyWithToolsResult = {
  text: string;
  proposal: AnthropicToolProposal | null;
};

type ReviseDraftParams = {
  sessionId: string;
  currentSummary: string;
  currentArgs: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  userInstruction: string;
};

type ReviseDraftResult = {
  summary: string;
  args: Record<string, unknown>;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

type AnthropicMessageResponse = {
  content?: Array<Record<string, unknown>>;
};

const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 12_000;
const MAX_TURN_CHARS = 1_800;
const MAX_TOOL_RESULT_CHARS = 14_000;
const TOOL_RESULT_MAX_DEPTH = 6;
const TOOL_RESULT_MAX_ARRAY_ITEMS = 24;
const TOOL_RESULT_MAX_OBJECT_KEYS = 40;
const TOOL_RESULT_MAX_STRING_CHARS = 320;

export class AnthropicService {
  private readonly historyBySession = new Map<string, Turn[]>();
  private readonly maxHistory = MAX_HISTORY_TURNS;
  private readonly baseUrl = "https://api.anthropic.com/v1/messages";

  constructor(private readonly env: EnvConfig) {}

  isConfigured(): boolean {
    return Boolean(this.env.anthropicApiKey);
  }

  clearSession(sessionId: string): void {
    this.historyBySession.delete(sessionId);
  }

  async generateReply(
    sessionId: string,
    userText: string,
    onPartial: (text: string) => void
  ): Promise<string> {
    if (!this.env.anthropicApiKey) {
      const fallback = fallbackReply(userText);
      emitChunkedText(fallback, onPartial);
      this.pushTurn(sessionId, { role: "user", content: userText });
      this.pushTurn(sessionId, { role: "assistant", content: fallback });
      return fallback;
    }

    const history = this.getTrimmedHistory(sessionId);
    const messages: AnthropicMessage[] = [...history, { role: "user", content: userText }];
    const response = await this.callAnthropic({
      model: this.env.anthropicModel,
      max_tokens: 450,
      system: getBaseSystemPrompt(),
      messages
    });

    const text = extractText(response) || "I could not generate a response right now.";
    this.pushTurn(sessionId, { role: "user", content: userText });
    this.pushTurn(sessionId, { role: "assistant", content: text });
    emitChunkedText(text, onPartial);
    return text;
  }

  async generateReplyWithTools(params: GenerateReplyWithToolsParams): Promise<GenerateReplyWithToolsResult> {
    if (!this.env.anthropicApiKey || params.tools.length === 0) {
      const text = await this.generateReply(params.sessionId, params.userText, params.onPartial);
      return { text, proposal: null };
    }

    const history = this.getTrimmedHistory(params.sessionId);
    const baseMessages: AnthropicMessage[] = [...history, { role: "user", content: params.userText }];
    let messages = baseMessages;
    const maxLoops = 4;

    for (let index = 0; index < maxLoops; index += 1) {
      const response = await this.callAnthropic({
        model: this.env.anthropicModel,
        max_tokens: 700,
        system: getToolSystemPrompt(),
        messages,
        tools: params.tools
      });

      const content = Array.isArray(response.content) ? response.content : [];
      const text = extractText(response).trim();
      const toolUses = extractToolCalls(content);

      if (toolUses.length === 0) {
        const finalText = text || "Done.";
        this.pushTurn(params.sessionId, { role: "user", content: params.userText });
        this.pushTurn(params.sessionId, { role: "assistant", content: finalText });
        emitChunkedText(finalText, params.onPartial);
        return { text: finalText, proposal: null };
      }

      const toolResults: Array<Record<string, unknown>> = [];
      let proposal: AnthropicToolProposal | null = null;

      for (const toolUse of toolUses) {
        const args = ensureObject(toolUse.input);
        if (params.isMutatingTool(toolUse.name)) {
          proposal = {
            toolName: toolUse.name,
            args,
            assistantPreface: text,
            summary: summarizeToolAction(toolUse.name, args)
          };
          break;
        }

        try {
          const result = await params.executeReadTool(toolUse.name, args);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: safeJsonForModel(compactToolResultForModel(result))
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: safeJsonForModel({
              error: toErrorMessage(error),
              tool: toolUse.name
            })
          });
        }
      }

      if (proposal) {
        const proposalText =
          text ||
          `I prepared the action ${proposal.toolName}. Review the draft details and tell me if you want changes, approval, or rejection.`;
        this.pushTurn(params.sessionId, { role: "user", content: params.userText });
        this.pushTurn(params.sessionId, { role: "assistant", content: proposalText });
        emitChunkedText(proposalText, params.onPartial);
        return { text: proposalText, proposal };
      }

      messages = [
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content: toolResults
        }
      ];
    }

    const fallback =
      "I reached the tool loop limit for this request. Please retry with a slightly narrower instruction.";
    this.pushTurn(params.sessionId, { role: "user", content: params.userText });
    this.pushTurn(params.sessionId, { role: "assistant", content: fallback });
    emitChunkedText(fallback, params.onPartial);
    return { text: fallback, proposal: null };
  }

  async reviseDraft(params: ReviseDraftParams): Promise<ReviseDraftResult> {
    if (!this.env.anthropicApiKey) {
      return {
        summary: `Updated draft: ${params.userInstruction}`,
        args: {
          ...params.currentArgs,
          instructions: params.userInstruction
        }
      };
    }

    const prompt = [
      "You revise structured action arguments.",
      "Return only valid JSON with this exact shape: {\"summary\": string, \"arguments\": object}.",
      "Do not include markdown, explanations, or code fences.",
      "",
      `Current summary: ${params.currentSummary}`,
      `Current arguments: ${safeJson(params.currentArgs)}`,
      `Tool input schema: ${safeJson(params.inputSchema)}`,
      `User revision request: ${params.userInstruction}`
    ].join("\n");

    const response = await this.callAnthropic({
      model: this.env.anthropicModel,
      max_tokens: 550,
      system: "You are a strict JSON generator.",
      messages: [{ role: "user", content: prompt }]
    });

    const raw = extractText(response);
    const parsed = tryParseJson(raw);
    if (!parsed || !isObject(parsed.arguments) || typeof parsed.summary !== "string") {
      return {
        summary: `Updated draft: ${params.userInstruction}`,
        args: {
          ...params.currentArgs,
          instructions: params.userInstruction
        }
      };
    }

    return {
      summary: parsed.summary.trim() || params.currentSummary,
      args: parsed.arguments
    };
  }

  private getHistory(sessionId: string): Turn[] {
    const turns = this.historyBySession.get(sessionId) ?? [];
    if (!this.historyBySession.has(sessionId)) {
      this.historyBySession.set(sessionId, turns);
    }
    return turns;
  }

  private pushTurn(sessionId: string, turn: Turn): void {
    const turns = this.getHistory(sessionId);
    turns.push({
      ...turn,
      content: clampText(turn.content, MAX_TURN_CHARS)
    });
    while (turns.length > this.maxHistory) {
      turns.shift();
    }
  }

  private getTrimmedHistory(sessionId: string): Turn[] {
    const turns = this.getHistory(sessionId);
    const selected: Turn[] = [];
    let totalChars = 0;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      totalChars += turn.content.length;
      if (selected.length >= this.maxHistory || totalChars > MAX_HISTORY_CHARS) {
        break;
      }
      selected.unshift(turn);
    }

    return selected;
  }

  private async callAnthropic(body: Record<string, unknown>): Promise<AnthropicMessageResponse> {
    if (!this.env.anthropicApiKey) {
      return {};
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.env.anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errBody = await safeText(response);
      throw new Error(`Anthropic error ${response.status}: ${errBody}`);
    }
    return (await response.json()) as AnthropicMessageResponse;
  }
}

function getBaseSystemPrompt(): string {
  return [
    "You are a natural voice assistant.",
    "Keep responses concise, friendly, and easy to listen to.",
    "Use context from prior turns when useful."
  ].join(" ");
}

function getToolSystemPrompt(): string {
  return [
    "You are a voice action assistant with tools.",
    "Use tools whenever they provide concrete data.",
    "For read/list/search style tasks: call tools directly and then summarize clearly.",
    "For write/send/create/update/delete style tasks: still choose the correct tool and arguments.",
    "The execution layer will enforce approval for mutating actions.",
    "If the request is ambiguous between multiple apps, ask one short clarification question."
  ].join(" ");
}

function extractText(data: AnthropicMessageResponse): string {
  const content = Array.isArray(data.content) ? data.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join(" ")
    .trim();
}

function extractToolCalls(content: Array<Record<string, unknown>>): Array<{
  id: string;
  name: string;
  input: unknown;
}> {
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (block?.type !== "tool_use") {
      continue;
    }
    const id = typeof block.id === "string" ? block.id : "";
    const name = typeof block.name === "string" ? block.name : "";
    if (!id || !name) {
      continue;
    }
    calls.push({
      id,
      name,
      input: block.input
    });
  }
  return calls;
}

function summarizeToolAction(toolName: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) {
    return `Prepared ${toolName} with default parameters.`;
  }
  const excerpt = keys
    .slice(0, 4)
    .map((key) => `${key}: ${previewValue(args[key])}`)
    .join(", ");
  return `Prepared ${toolName} with ${excerpt}.`;
}

function previewValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[structured]";
}

function emitChunkedText(text: string, onPartial: (text: string) => void): void {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return;
  }

  const chunkSize = 6;
  for (let i = 0; i < words.length; i += chunkSize) {
    const partial = words.slice(0, i + chunkSize).join(" ");
    onPartial(partial);
  }
}

function fallbackReply(userText: string): string {
  const lower = userText.toLowerCase();
  if (lower.includes("hello") || lower.includes("hi")) {
    return "Hi. I can hear you clearly. Tell me what you need and I will help step by step.";
  }

  if (lower.includes("weather")) {
    return "I do not have live weather tools connected yet, but I can still help you plan based on your location and timing.";
  }

  return "I heard you. Could you add one more detail so I can give a sharper answer?";
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (isObject(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (isObject(parsed)) {
      return parsed;
    }
  }
  return {};
}

function tryParseJson(value: unknown): any {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    const extracted = value.match(/\{[\s\S]*\}/)?.[0];
    if (!extracted) {
      return null;
    }
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

function safeJsonForModel(value: unknown): string {
  const encoded = safeJson(value);
  if (encoded.length <= MAX_TOOL_RESULT_CHARS) {
    return encoded;
  }

  const previewLength = Math.min(3_000, Math.max(300, MAX_TOOL_RESULT_CHARS - 800));
  return safeJson({
    truncated: true,
    originalLength: encoded.length,
    preview: `${encoded.slice(0, previewLength)}...(truncated)`
  });
}

function compactToolResultForModel(value: unknown): unknown {
  return compactToolValue(value, 0, new WeakSet<object>());
}

function compactToolValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return clampText(value, TOOL_RESULT_MAX_STRING_CHARS);
  }

  if (depth >= TOOL_RESULT_MAX_DEPTH) {
    return "[truncated-depth]";
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, TOOL_RESULT_MAX_ARRAY_ITEMS).map((entry) => compactToolValue(entry, depth + 1, seen));
    if (value.length > TOOL_RESULT_MAX_ARRAY_ITEMS) {
      limited.push(`[+${value.length - TOOL_RESULT_MAX_ARRAY_ITEMS} more items]`);
    }
    return limited;
  }

  if (isObject(value)) {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    const entries = Object.entries(value);
    const reduced: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, TOOL_RESULT_MAX_OBJECT_KEYS)) {
      reduced[key] = compactToolValue(entry, depth + 1, seen);
    }
    if (entries.length > TOOL_RESULT_MAX_OBJECT_KEYS) {
      reduced.__truncatedKeys = entries.length - TOOL_RESULT_MAX_OBJECT_KEYS;
    }
    return reduced;
  }

  return String(value);
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 15))}...(truncated)`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
