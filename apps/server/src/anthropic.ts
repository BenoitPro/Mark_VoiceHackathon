import type { EnvConfig } from "./env.js";
import { CircuitBreaker, isRetriableError, withRetries, withTimeout } from "./reliability.js";

type Turn = {
  role: "user" | "assistant";
  content: string;
};

export type EmailWorkflowDecisionAction =
  | "pause"
  | "summary"
  | "choose_category"
  | "show_current_email"
  | "next_email"
  | "draft_reply"
  | "revise_draft"
  | "send_reply"
  | "handoff";

export type EmailWorkflowDecisionCategory = "respond_needed" | "must_know";

export type EmailWorkflowDecision = {
  action: EmailWorkflowDecisionAction;
  category: EmailWorkflowDecisionCategory | null;
  draftInstruction: string | null;
};

export type EmailWorkflowDecisionContext = {
  hasActiveWorkflow: boolean;
  windowLabel: string | null;
  counts: {
    scanned: number;
    respondNeeded: number;
    mustKnow: number;
    optional: number;
    sent: number;
  };
  selectedCategory: EmailWorkflowDecisionCategory | null;
  selectedIndex: number | null;
  hasDraftForCurrentEmail: boolean;
  currentEmail: {
    from: string;
    subject: string;
    snippet: string;
    category: EmailWorkflowDecisionCategory;
  } | null;
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

type DecideEmailWorkflowTurnParams = {
  sessionId: string;
  userText: string;
  context: EmailWorkflowDecisionContext;
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
  private readonly breaker: CircuitBreaker;

  constructor(private readonly env: EnvConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: env.providerCircuitBreakerFailures,
      cooldownMs: env.providerCircuitBreakerCooldownMs
    });
  }

  isConfigured(): boolean {
    return Boolean(this.env.anthropicApiKey);
  }

  clearSession(sessionId: string): void {
    this.historyBySession.delete(sessionId);
  }

  async generateImmediateAck(userText: string): Promise<string> {
    if (!this.env.anthropicApiKey) {
      return fallbackImmediateAck(userText);
    }

    try {
      const response = await this.callAnthropic({
        model: this.env.anthropicModel,
        max_tokens: 80,
        system: getImmediateAckSystemPrompt(),
        messages: [{ role: "user", content: userText }]
      });

      const text = normalizeImmediateAck(extractText(response));
      if (text) {
        return text;
      }
    } catch {
      // Falls back below.
    }

    return fallbackImmediateAck(userText);
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

  async decideEmailWorkflowTurn(params: DecideEmailWorkflowTurnParams): Promise<EmailWorkflowDecision> {
    if (!this.env.anthropicApiKey) {
      return fallbackEmailWorkflowDecision(params.userText, params.context);
    }

    try {
      const response = await this.callAnthropic({
        model: this.env.anthropicModel,
        max_tokens: 220,
        temperature: 0,
        system: getEmailWorkflowDecisionPrompt(),
        messages: [
          {
            role: "user",
            content: safeJson({
              userText: params.userText,
              context: params.context
            })
          }
        ]
      });
      const raw = extractText(response);
      const parsed = tryParseJson(raw);
      return sanitizeEmailWorkflowDecision(parsed, params.userText, params.context);
    } catch {
      return fallbackEmailWorkflowDecision(params.userText, params.context);
    }
  }

  async polishEmailWorkflowReply(userText: string, rawReply: string): Promise<string> {
    const singleLine = rawReply.replace(/\s+/g, " ").trim();
    if (!singleLine) {
      return rawReply;
    }
    if (!this.env.anthropicApiKey) {
      return singleLine;
    }

    try {
      const response = await this.callAnthropic({
        model: this.env.anthropicModel,
        max_tokens: 180,
        temperature: 0.2,
        system: getEmailWorkflowPolishPrompt(),
        messages: [
          {
            role: "user",
            content: safeJson({
              userText,
              rawReply: singleLine
            })
          }
        ]
      });
      const polished = extractText(response).replace(/\s+/g, " ").trim();
      if (!polished) {
        return singleLine;
      }
      return polished;
    } catch {
      return singleLine;
    }
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

    const response = await this.breaker.execute(() =>
      withRetries(
        () =>
          withTimeout(
            async (signal) =>
              fetch(this.baseUrl, {
                method: "POST",
                signal,
                headers: {
                  "content-type": "application/json",
                  "x-api-key": this.env.anthropicApiKey!,
                  "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify(body)
              }),
            this.env.providerTimeoutMs,
            "Anthropic request timed out."
          ),
        {
          retries: this.env.providerMaxRetries,
          shouldRetry: isRetriableError
        }
      )
    );

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

function getImmediateAckSystemPrompt(): string {
  return [
    "You produce only an immediate acknowledgement before a longer task runs.",
    "Reply in the same language as the user.",
    "Use one short sentence (maximum 22 words).",
    "Confirm that you understood and that the user should wait while you work.",
    "No markdown, no bullets, no extra commentary."
  ].join(" ");
}

function getEmailWorkflowDecisionPrompt(): string {
  return [
    "You are the controller for an email triage voice workflow.",
    "Return JSON only with this exact shape:",
    '{"action":"pause|summary|choose_category|show_current_email|next_email|draft_reply|revise_draft|send_reply|handoff","category":"respond_needed|must_know|null","draftInstruction":"string|null"}',
    "Interpret the user's latest message in context.",
    "Decide only one best next action.",
    "Use choose_category when user picks response-needed vs must-know.",
    "Use show_current_email when user asks for details/current email.",
    "Use next_email when user asks for next/continue/another.",
    "Use draft_reply when user asks to draft/write/reply and there is no revision request.",
    "Use revise_draft when user requests changes to an existing draft.",
    "Use send_reply when user explicitly asks to send, or confirms positively while a draft exists for current email.",
    "Use pause when user asks to stop/pause/cancel this flow.",
    "Use summary when user asks for counts/recap/status.",
    "Use handoff when user asks something unrelated to this email workflow.",
    "If category is needed but not explicit, infer from context.",
    "If draft action is chosen, set draftInstruction to a concise instruction based on the user request; otherwise null.",
    "Do not include markdown or explanation."
  ].join(" ");
}

function getEmailWorkflowPolishPrompt(): string {
  return [
    "You rewrite a server-produced email workflow response for natural voice conversation.",
    "Output one to three short sentences in the same language as userText.",
    "Preserve all concrete facts from rawReply: counts, categories, sender names, subject meaning, and outcomes.",
    "Do not invent new facts, actions, tools, or dates.",
    "Do not use markdown, bullets, or code fences."
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

function fallbackImmediateAck(userText: string): string {
  if (looksFrench(userText)) {
    return "D'accord, je m'en occupe. Veuillez patienter pendant que je traite la tâche.";
  }
  return "Got it. I am on it now. Please wait while I complete the task.";
}

function normalizeImmediateAck(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  const words = cleaned.split(" ").slice(0, 22);
  return words.join(" ");
}

function looksFrench(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /[àâçéèêëîïôûùüÿœ]/.test(normalized) ||
    /\b(je|tu|vous|nous|bonjour|merci|avec|pour|sur|dans|pas|oui|non|s'il|d'accord)\b/.test(normalized)
  );
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

function sanitizeEmailWorkflowDecision(
  value: unknown,
  userText: string,
  context: EmailWorkflowDecisionContext
): EmailWorkflowDecision {
  if (!isObject(value)) {
    return fallbackEmailWorkflowDecision(userText, context);
  }

  const action = sanitizeDecisionAction(typeof value.action === "string" ? value.action : "");
  const rawCategory = typeof value.category === "string" ? value.category : null;
  const category = sanitizeDecisionCategory(rawCategory, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow);
  const draftInstruction =
    typeof value.draftInstruction === "string" && value.draftInstruction.trim().length > 0
      ? clampText(value.draftInstruction.trim(), 260)
      : null;

  return {
    action,
    category,
    draftInstruction: action === "draft_reply" || action === "revise_draft" ? draftInstruction : null
  };
}

function sanitizeDecisionAction(action: string): EmailWorkflowDecisionAction {
  const allowed: EmailWorkflowDecisionAction[] = [
    "pause",
    "summary",
    "choose_category",
    "show_current_email",
    "next_email",
    "draft_reply",
    "revise_draft",
    "send_reply",
    "handoff"
  ];
  return (allowed as string[]).includes(action) ? (action as EmailWorkflowDecisionAction) : "handoff";
}

function sanitizeDecisionCategory(
  rawCategory: string | null,
  selectedCategory: EmailWorkflowDecisionCategory | null,
  respondNeededCount: number,
  mustKnowCount: number
): EmailWorkflowDecisionCategory | null {
  if (rawCategory === "respond_needed" || rawCategory === "must_know") {
    return rawCategory;
  }
  if (selectedCategory) {
    return selectedCategory;
  }
  if (respondNeededCount > 0) {
    return "respond_needed";
  }
  if (mustKnowCount > 0) {
    return "must_know";
  }
  return null;
}

function fallbackEmailWorkflowDecision(
  userText: string,
  context: EmailWorkflowDecisionContext
): EmailWorkflowDecision {
  const normalized = userText.toLowerCase().trim();
  if (!normalized) {
    return {
      action: "summary",
      category: sanitizeDecisionCategory(null, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow),
      draftInstruction: null
    };
  }

  if (/\b(stop|cancel|pause|exit|arr[êe]te|annule)\b/.test(normalized)) {
    return { action: "pause", category: null, draftInstruction: null };
  }
  if (/\b(summary|recap|counts?|how many|r[ée]sum[ée]|combien)\b/.test(normalized)) {
    return { action: "summary", category: null, draftInstruction: null };
  }
  if (/\b(next|continue|another|move on|suivant|autre)\b/.test(normalized)) {
    return {
      action: "next_email",
      category: sanitizeDecisionCategory(null, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow),
      draftInstruction: null
    };
  }
  if (/\b(send|envoie|envoyer|approve and send)\b/.test(normalized)) {
    return {
      action: "send_reply",
      category: sanitizeDecisionCategory(null, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow),
      draftInstruction: null
    };
  }
  if (/\b(modify|change|edit|rewrite|revise|modifie|r[ée][ée]cris|plus court|plus long)\b/.test(normalized)) {
    return {
      action: "revise_draft",
      category: sanitizeDecisionCategory(null, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow),
      draftInstruction: userText
    };
  }
  if (/\b(draft|compose|write|reply|brouillon|r[ée]dige|[ée]cris)\b/.test(normalized)) {
    return {
      action: "draft_reply",
      category: sanitizeDecisionCategory(null, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow),
      draftInstruction: userText
    };
  }
  if (/^(yes|yeah|yep|sure|go ahead|do it|ok(?:ay)?|oui|vas[- ]?y|d'accord)\b/.test(normalized)) {
    return {
      action: context.hasDraftForCurrentEmail ? "send_reply" : "draft_reply",
      category: sanitizeDecisionCategory(null, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow),
      draftInstruction: context.hasDraftForCurrentEmail ? null : "Create the first draft."
    };
  }
  if (/\b(response|respond|reply|r[ée]ponse|r[ée]pondre)\b/.test(normalized)) {
    return {
      action: "choose_category",
      category: "respond_needed",
      draftInstruction: null
    };
  }
  if (/\b(must know|must-know|important|alerts?|critical|importantes?|critiques?)\b/.test(normalized)) {
    return {
      action: "choose_category",
      category: "must_know",
      draftInstruction: null
    };
  }
  if (/\b(detail|details|donne les d[ée]tails|explique|show)\b/.test(normalized)) {
    return {
      action: "show_current_email",
      category: sanitizeDecisionCategory(null, context.selectedCategory, context.counts.respondNeeded, context.counts.mustKnow),
      draftInstruction: null
    };
  }

  return {
    action: "handoff",
    category: null,
    draftInstruction: null
  };
}
