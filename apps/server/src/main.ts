import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";

import {
  WS_EVENTS,
  type ActionApproveEvent,
  type ActionExecutedEvent,
  type ActionFailedEvent,
  type ActionHistoryResponse,
  type BillingCheckoutResponse,
  type BillingStatusResponse,
  type ActionProposedEvent,
  type ActionRejectEvent,
  type ActionRejectedEvent,
  type ActionRevisedEvent,
  type ActionStatusEvent,
  type AgentReplyEvent,
  type AudioUserChunkEvent,
  type AudioUserUtteranceEvent,
  type AuthMeResponse,
  type ComposioCatalogItem,
  type ComposioConnectLinkResponse,
  type ComposioConnectionItem,
  type ErrorRaisedEvent,
  type TelemetryEventName,
  type TelemetryEventRequest,
  type SessionStartedEvent,
  type SttStatusEvent,
  type TranscriptEvent,
  type VoiceSessionSocketAuth,
  type TtsAudioChunkEvent,
  type TtsAudioEndEvent
} from "@mark/contracts";

import { ActionOrchestrator } from "./actionOrchestrator.js";
import {
  AnthropicService,
  type EmailWorkflowDecisionCategory,
  type EmailWorkflowDecisionContext
} from "./anthropic.js";
import { ApprovalIntentService } from "./approvalIntent.js";
import { AuthError, AuthService, getBearerToken, type AuthenticatedUser } from "./auth.js";
import { AuditService } from "./audit.js";
import { ComposioService, type AgentToolDefinition } from "./composio.js";
import { EmailIntentRouter, type EmailIntent, normalizeTimeZone } from "./emailIntentRouter.js";
import { ElevenLabsService } from "./elevenlabs.js";
import { getEnvConfig } from "./env.js";
import {
  EmailWorkflowStore,
  type EmailWorkflowActionRef,
  type EmailWorkflowConversation,
  type EmailWorkflowSnapshot
} from "./emailWorkflowStore.js";
import { GmailInboxTriageService, type TriagedEmail } from "./gmailInboxTriage.js";
import { GmailPriorityLlmClassifier } from "./gmailPriorityLlm.js";
import { SpeechmaticsAdapter } from "./speechmatics.js";
import { SpeechmaticsTtsService } from "./speechmaticsTts.js";
import { TimedSessionCache } from "./toolCatalogCache.js";
import { TtsRouter } from "./ttsRouter.js";

type EmailTriageCache = {
  workflowId: string;
  createdAt: string;
  windowLabel: string;
  resolvedQuery: string;
  timeZone: string;
  scannedCount: number;
  respondNeededCount: number;
  mustKnowCount: number;
  respondNeededDoneCount: number;
  mustKnowDoneCount: number;
  sentCount: number;
  optionalCount: number;
  capHit: boolean;
  respondNeededItems: TriagedEmail[];
  mustKnowItems: TriagedEmail[];
};

type EmailFocusCategory = "respond_needed" | "must_know";

type EmailConversationState = EmailWorkflowConversation;

type SessionState = {
  user: AuthenticatedUser;
  timeZone: string;
  lastCommittedTextHash: string;
  processing: boolean;
  processingRunId: number;
  activeTtsAbortController: AbortController | null;
  activeEmailWorkflowId: string | null;
  emailTriageCache: EmailTriageCache | null;
  emailConversation: EmailConversationState;
  recentUtteranceAtMs: number[];
};

type AuthedRequest = Request & {
  authUser: AuthenticatedUser;
};

const env = getEnvConfig();
const stt = new SpeechmaticsAdapter(env);
const llm = new AnthropicService(env);
const elevenLabsTts = new ElevenLabsService(env);
const speechmaticsTts = new SpeechmaticsTtsService(env);
const tts = new TtsRouter(speechmaticsTts, elevenLabsTts);
const auth = new AuthService(env);
const audit = new AuditService(env);
const composio = new ComposioService(env);
const actionOrchestrator = new ActionOrchestrator(audit);
const approvalIntent = new ApprovalIntentService();
const emailIntentRouter = new EmailIntentRouter();
const gmailPriorityClassifier = new GmailPriorityLlmClassifier(env);
const gmailInboxTriage = new GmailInboxTriageService(composio, gmailPriorityClassifier);
const emailWorkflowStore = new EmailWorkflowStore();
const toolsBySessionCache = new TimedSessionCache<Awaited<ReturnType<typeof composio.listToolsByUser>>>(60_000);

const EMAIL_REPLY_DRAFT_MAX_CHARS = 1_400;
const BILLING_PAID = "paid";
const BILLING_TRIAL = "trial";
const MAX_AUTH_CONFIG_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 300;

const TELEMETRY_EVENTS: Set<TelemetryEventName> = new Set([
  "visit",
  "signup",
  "gmail_connected",
  "first_triage",
  "checkout_clicked"
]);

const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);
app.use(express.json({ limit: "5mb" }));
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || env.webOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin denied"));
    },
    credentials: false
  })
);
app.use(
  "/v1",
  rateLimit({
    windowMs: env.apiRateLimitWindowMs,
    max: env.apiRateLimitMax,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many requests. Please retry shortly." }
  })
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    sttConfigured: stt.isConfigured(),
    ttsConfigured: tts.isAnyConfigured(),
    ttsProviders: {
      speechmaticsConfigured: speechmaticsTts.isConfigured(),
      elevenLabsConfigured: elevenLabsTts.isConfigured(),
      priority: ["speechmatics", "elevenlabs"] as const
    },
    llmConfigured: llm.isConfigured(),
    authConfigured: auth.isConfigured(),
    composioConfigured: composio.isConfigured()
  });
});

app.get("/health/voice", (_req, res) => {
  res.json({
    sttConfigured: stt.isConfigured(),
    ttsConfigured: tts.isAnyConfigured(),
    ttsProviders: {
      speechmaticsConfigured: speechmaticsTts.isConfigured(),
      elevenLabsConfigured: elevenLabsTts.isConfigured(),
      priority: ["speechmatics", "elevenlabs"] as const
    },
    llmConfigured: llm.isConfigured(),
    authConfigured: auth.isConfigured(),
    composioConfigured: composio.isConfigured(),
    lastSttErrorAt: stt.getLastProviderErrorAt(),
    lastTtsErrorAt: tts.getLastProviderErrorAt()
  });
});

app.get("/health/readiness", (_req, res) => {
  const dependencies = {
    stt: stt.isConfigured(),
    tts: tts.isAnyConfigured(),
    llm: llm.isConfigured(),
    auth: auth.isConfigured(),
    composio: composio.isConfigured()
  };
  const ready = Object.values(dependencies).every(Boolean);

  res.status(ready ? 200 : 503).json({
    ok: ready,
    dependencies,
    checkedAt: new Date().toISOString()
  });
});

app.get("/v1/auth/me", requireHttpAuth, (req, res) => {
  const { authUser } = req as AuthedRequest;
  res.json({
    userId: authUser.id,
    email: authUser.email
  } satisfies AuthMeResponse);
});

app.get("/v1/billing/status", requireHttpAuth, (req, res) => {
  const { authUser } = req as AuthedRequest;
  const plan = resolveBillingPlan(authUser);
  res.json({
    plan,
    checkoutConfigured: Boolean(env.stripeCheckoutUrl),
    checkoutUrl: env.stripeCheckoutUrl
  } satisfies BillingStatusResponse);
});

app.post("/v1/billing/checkout-link", requireHttpAuth, (req, res) => {
  const { authUser } = req as AuthedRequest;
  if (!env.stripeCheckoutUrl) {
    res.status(503).json({ message: "Billing checkout is not configured yet." });
    return;
  }

  emitStructuredLog("info", {
    event: "billing.checkout.link_generated",
    userId: authUser.id
  });

  res.json({
    checkoutUrl: env.stripeCheckoutUrl
  } satisfies BillingCheckoutResponse);
});

app.post("/v1/telemetry/events", async (req, res) => {
  const parsed = parseTelemetryEvent(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }
  if (!env.telemetryEnabled) {
    res.status(202).json({ accepted: false });
    return;
  }

  const authHeaderToken = getBearerToken(req.header("authorization"));
  let userId: string | null = null;
  if (authHeaderToken) {
    try {
      const user = await auth.verifyAccessToken(authHeaderToken);
      userId = user.id;
    } catch {
      userId = null;
    }
  }

  emitStructuredLog("info", {
    event: "telemetry.event",
    telemetryEvent: parsed.value.event,
    metadata: parsed.value.metadata ?? {},
    userId
  });

  res.status(202).json({ accepted: true });
});

app.get("/v1/composio/catalog", requireHttpAuth, async (_req, res) => {
  try {
    if (!composio.isConfigured()) {
      res.json([] satisfies ComposioCatalogItem[]);
      return;
    }
    const catalog = await composio.listCatalog();
    res.json(
      catalog.map((item) => ({
        authConfigId: item.authConfigId,
        name: item.name,
        toolkitSlug: item.toolkitSlug,
        toolkitName: item.toolkitName,
        authScheme: item.authScheme,
        isComposioManaged: item.isComposioManaged
      } satisfies ComposioCatalogItem))
    );
  } catch (error) {
    const correlationId = randomUUID();
    emitStructuredLog("error", {
      event: "composio.catalog.failed",
      correlationId,
      error: toErrorMessage(error)
    });
    res.status(502).json({ message: `Could not load integration catalog. Ref: ${correlationId}` });
  }
});

app.post("/v1/composio/connect-link", requireHttpAuth, async (req, res) => {
  const { authUser } = req as AuthedRequest;
  const parsedConnectBody = parseConnectLinkBody(req.body);
  if (!parsedConnectBody.ok) {
    res.status(400).json({ message: parsedConnectBody.message });
    return;
  }

  try {
    const result = await composio.createConnectLink(authUser.composioUserId, parsedConnectBody.value.authConfigId);
    res.json({
      redirectUrl: result.redirectUrl,
      connectionRequestId: result.connectionRequestId
    } satisfies ComposioConnectLinkResponse);
  } catch (err) {
    const correlationId = randomUUID();
    emitStructuredLog("error", {
      event: "composio.connect_link.failed",
      userId: authUser.id,
      correlationId,
      error: toErrorMessage(err)
    });
    res.status(502).json({ message: `Could not start connection flow. Ref: ${correlationId}` });
  }
});

app.get("/v1/composio/connections", requireHttpAuth, async (req, res) => {
  const { authUser } = req as AuthedRequest;
  try {
    if (!composio.isConfigured()) {
      res.json([] satisfies ComposioConnectionItem[]);
      return;
    }
    const connections = await composio.listConnections(authUser.composioUserId);
    res.json(
      connections.map((item) => ({
        connectedAccountId: item.connectedAccountId,
        authConfigId: item.authConfigId,
        authConfigName: item.authConfigName,
        toolkitSlug: item.toolkitSlug,
        toolkitName: item.toolkitName,
        status: item.status
      } satisfies ComposioConnectionItem))
    );
  } catch (error) {
    const correlationId = randomUUID();
    emitStructuredLog("error", {
      event: "composio.connections.failed",
      userId: authUser.id,
      correlationId,
      error: toErrorMessage(error)
    });
    res.status(502).json({ message: `Could not load connected apps. Ref: ${correlationId}` });
  }
});

app.get("/v1/composio/connect/callback", async (req, res) => {
  const connectedAccountId = pickConnectionId(req.query);
  if (connectedAccountId && composio.isConfigured()) {
    await composio.waitForConnection(connectedAccountId).catch(() => undefined);
  }

  const location = new URL(env.webOrigin);
  location.searchParams.set("connected", connectedAccountId ? "1" : "0");
  if (connectedAccountId) {
    location.searchParams.set("connectedAccountId", connectedAccountId);
  }
  res.redirect(302, location.toString());
});

app.get("/v1/actions/history", requireHttpAuth, async (req, res) => {
  const { authUser } = req as AuthedRequest;
  try {
    const items = await audit.listHistory(authUser.id);
    res.json({ items } satisfies ActionHistoryResponse);
  } catch (error) {
    const correlationId = randomUUID();
    emitStructuredLog("error", {
      event: "audit.history.failed",
      userId: authUser.id,
      correlationId,
      error: toErrorMessage(error)
    });
    res.status(500).json({ message: `Could not load action history. Ref: ${correlationId}` });
  }
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  const message = toErrorMessage(error);
  if (message.includes("CORS origin denied")) {
    res.status(403).json({ message: "Origin is not allowed." });
    return;
  }
  next(error);
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: env.webOrigin
  }
});

const namespace = io.of("/v1/session");
const sessionStateBySocketId = new Map<string, SessionState>();

namespace.use(async (socket, next) => {
  try {
    const token = readSocketAccessToken(socket);
    const user = await auth.verifyAccessToken(token);
    socket.data.user = user;
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error("Unauthorized"));
  }
});

namespace.on("connection", (socket) => {
  const user = socket.data.user as AuthenticatedUser;
  const timeZone = readSocketTimeZone(socket);
  const state: SessionState = {
    user,
    timeZone,
    lastCommittedTextHash: "",
    processing: false,
    processingRunId: 0,
    activeTtsAbortController: null,
    activeEmailWorkflowId: null,
    emailTriageCache: null,
    emailConversation: createEmailConversationState(),
    recentUtteranceAtMs: []
  };
  hydrateSessionFromLatestWorkflow(state);
  sessionStateBySocketId.set(socket.id, state);

  const startedPayload: SessionStartedEvent = {
    sessionId: socket.id,
    greeting:
      state.emailTriageCache && state.emailTriageCache.respondNeededCount + state.emailTriageCache.mustKnowCount > 0
        ? "Ready. I restored your active inbox workflow and I can continue from where we stopped."
        : "Ready. I can now read data and prepare actions with your approval."
  };
  socket.emit(WS_EVENTS.SESSION_STARTED, startedPayload);

  if (!stt.isConfigured()) {
    emitSttStatus(socket, {
      code: "provider_error",
      message: "SPEECHMATICS_API_KEY missing. STT provider unavailable."
    });
  } else {
    emitSttStatus(socket, {
      code: "listening",
      message: "Listening for your request."
    });
  }

  socket.on(WS_EVENTS.AUDIO_USER_UTTERANCE, (payload: unknown) => {
    const parsed = parseAudioUserUtterance(payload);
    if (!parsed.ok) {
      emitError(socket, {
        message: parsed.message,
        code: "invalid_audio_payload",
        retryable: true
      });
      return;
    }
    void handleUserUtterance(socket, parsed.value);
  });

  // Keep this event for compatibility, but the active path is utterance upload.
  socket.on(WS_EVENTS.AUDIO_USER_CHUNK, (_payload: AudioUserChunkEvent) => {
    emitError(socket, {
      message: "Streaming chunk mode is disabled. Please use utterance mode.",
      code: "streaming_chunks_disabled",
      retryable: true
    });
  });

  socket.on(WS_EVENTS.STT_FINAL, (payload: TranscriptEvent) => {
    void processFinalTranscript(socket, payload.text);
  });

  socket.on(WS_EVENTS.ACTION_APPROVE, (payload: unknown) => {
    const parsed = parseActionApprove(payload);
    if (!parsed.ok) {
      emitError(socket, {
        message: parsed.message,
        code: "invalid_action_approve_payload",
        retryable: true
      });
      return;
    }
    void handleActionApprove(socket, parsed.value);
  });

  socket.on(WS_EVENTS.ACTION_REJECT, (payload: unknown) => {
    const parsed = parseActionReject(payload);
    if (!parsed.ok) {
      emitError(socket, {
        message: parsed.message,
        code: "invalid_action_reject_payload",
        retryable: true
      });
      return;
    }
    void handleActionReject(socket, parsed.value);
  });

  socket.on(WS_EVENTS.SESSION_RESET, () => {
    const state = ensureSessionState(socket.id);
    if (state.activeTtsAbortController) {
      state.activeTtsAbortController.abort("session-reset");
      state.activeTtsAbortController = null;
    }
    state.processingRunId += 1;
    state.processing = false;
    state.lastCommittedTextHash = "";
    if (state.activeEmailWorkflowId) {
      emailWorkflowStore.clearByWorkflowId(state.activeEmailWorkflowId);
    }
    state.activeEmailWorkflowId = null;
    state.emailTriageCache = null;
    state.emailConversation = createEmailConversationState();
    state.recentUtteranceAtMs = [];
    llm.clearSession(socket.id);
    actionOrchestrator.clearSession(socket.id);
    emitSttStatus(socket, {
      code: "listening",
      message: "Memory cleared. Listening."
    });
  });

  socket.on("disconnect", () => {
    const state = sessionStateBySocketId.get(socket.id);
    state?.activeTtsAbortController?.abort("socket-disconnect");
    toolsBySessionCache.clear(socket.id);
    sessionStateBySocketId.delete(socket.id);
    actionOrchestrator.clearSession(socket.id);
    llm.clearSession(socket.id);
  });
});

async function handleUserUtterance(socket: Socket, payload: AudioUserUtteranceEvent): Promise<void> {
  const state = ensureSessionState(socket.id);
  if (isSocketRateLimited(state)) {
    emitError(socket, {
      message: "Too many utterances in a short period. Please pause for a few seconds.",
      code: "utterance_rate_limited",
      retryable: true
    });
    return;
  }
  if (!stt.isConfigured()) {
    emitSttStatus(socket, {
      code: "provider_error",
      message: "Speech provider is not configured."
    });
    return;
  }

  if (!payload.audioBase64 || payload.mimeType !== "audio/mpeg") {
    emitError(socket, {
      message: "Invalid utterance payload.",
      code: "invalid_audio_payload",
      retryable: true
    });
    return;
  }

  if (state.processing) {
    if (state.activeTtsAbortController) {
      state.activeTtsAbortController.abort("interrupted-by-user");
    } else {
      return;
    }
  }

  const runId = state.processingRunId + 1;
  state.processingRunId = runId;
  state.processing = true;

  emitSttStatus(socket, {
    code: "warming_up",
    message: "Transcribing your voice."
  });

  try {
    const transcript = (await stt.transcribeUtterance(payload.audioBase64, payload.mimeType)).trim();

    if (!transcript) {
      emitSttStatus(socket, {
        code: "listening",
        message: "No speech detected. Try again."
      });
      return;
    }

    await processFinalTranscript(socket, transcript);
  } catch (err) {
    const correlationId = randomUUID();
    emitStructuredLog("error", {
      event: "voice.stt.failed",
      sessionId: socket.id,
      userId: state.user.id,
      correlationId,
      error: toErrorMessage(err)
    });
    emitError(socket, {
      message: `Speech transcription failed. Ref: ${correlationId}`,
      code: "stt_failed",
      retryable: true,
      correlationId
    });
    emitSttStatus(socket, {
      code: "provider_error",
      message: "Speech transcription failed."
    });
  } finally {
    if (state.processingRunId === runId) {
      state.processing = false;
    }
  }
}

async function processFinalTranscript(socket: Socket, rawText: string): Promise<void> {
  const text = rawText.trim();
  if (!text) {
    return;
  }

  const state = ensureSessionState(socket.id);
  const hash = normalizeHash(text);
  if (state.lastCommittedTextHash === hash) {
    return;
  }
  state.lastCommittedTextHash = hash;

  socket.emit(WS_EVENTS.STT_FINAL, { text } satisfies TranscriptEvent);

  const pending = actionOrchestrator.getPending(socket.id);
  if (pending) {
    const pendingReply = await handlePendingVoiceTurn(socket, state.user, pending, text);
    await emitAgentFinalAndSpeak(socket, pendingReply);
    return;
  }

  const emailConversationReply = await handleEmailConversationTurn(socket, state, text);
  if (emailConversationReply) {
    emitAgentReplyPartial(socket, emailConversationReply);
    await emitAgentFinalAndSpeak(socket, emailConversationReply);
    return;
  }

  const emailIntent = emailIntentRouter.detect(text, { timeZone: state.timeZone });
  if (emailIntent) {
    emitEmailProcessingAck(socket, text);
    let triageReply = "";
    try {
      triageReply = await handleEmailIntent(socket, state, emailIntent);
    } catch (err) {
      const correlationId = randomUUID();
      emitStructuredLog("error", {
        event: "voice.gmail.triage_failed",
        sessionId: socket.id,
        userId: state.user.id,
        correlationId,
        input: text,
        error: toErrorMessage(err)
      });
      emitError(socket, {
        message: `Inbox triage is temporarily unavailable. Ref: ${correlationId}`,
        code: "gmail_triage_failed",
        retryable: true,
        correlationId
      });
      triageReply = "I could not process your inbox right now. Please retry in a few seconds.";
    }
    emitAgentReplyPartial(socket, triageReply);
    await emitAgentFinalAndSpeak(socket, triageReply);
    return;
  }

  let finalReply = "";
  try {
    let toolsByName: Record<string, Awaited<ReturnType<typeof composio.listToolsByUser>>[string]> = {};
    try {
      toolsByName = await toolsBySessionCache.get(socket.id, async () =>
        composio.listToolsByUser(state.user.composioUserId)
      );
    } catch (toolCatalogError) {
      const correlationId = randomUUID();
      emitStructuredLog("warn", {
        event: "voice.tools.catalog_failed",
        sessionId: socket.id,
        userId: state.user.id,
        correlationId,
        error: toErrorMessage(toolCatalogError)
      });
      emitError(socket, {
        message: `Connected tools are temporarily unavailable. Ref: ${correlationId}`,
        code: "tool_catalog_unavailable",
        retryable: true,
        correlationId
      });
      toolsByName = {};
    }
    const availableTools = Object.values(toolsByName).map((tool) => ({
      name: tool.toolName,
      description: tool.description,
      input_schema: tool.inputSchema
    }));

    const agentResult = await llm.generateReplyWithTools({
      sessionId: socket.id,
      userText: text,
      tools: availableTools,
      executeReadTool: async (toolName, args) => {
        const tool = toolsByName[toolName];
        if (!tool) {
          throw new Error(`Tool ${toolName} is not available for this user.`);
        }
        return composio.executeTool(state.user.composioUserId, tool, args);
      },
      isMutatingTool: (toolName) => toolsByName[toolName]?.isMutating ?? true,
      onPartial: (partialText) => {
        socket.emit(WS_EVENTS.AGENT_REPLY_PARTIAL, { text: partialText } satisfies AgentReplyEvent);
      }
    });

    finalReply = agentResult.text;

    if (agentResult.proposal) {
      const proposedTool = toolsByName[agentResult.proposal.toolName];
      if (proposedTool) {
        const draft = await actionOrchestrator.createProposal({
          userId: state.user.id,
          sessionId: socket.id,
          toolSlug: proposedTool.toolSlug,
          toolkitSlug: proposedTool.toolkitSlug,
          connectedAccountId: proposedTool.connectedAccountId,
          summary: agentResult.proposal.summary,
          args: agentResult.proposal.args,
          requiresApproval: true
        });

        emitActionProposed(socket, {
          draft,
          message: "Draft prepared. Ask for changes, approval, or rejection."
        });
        emitActionStatus(socket, draft, "pending_approval", "Waiting for your validation.");

        finalReply = [
          finalReply,
          "I drafted this action. Tell me any changes you want, then approve when it is ready."
        ]
          .filter(Boolean)
          .join(" ");
      }
    }
  } catch (err) {
    const correlationId = randomUUID();
    emitStructuredLog("error", {
      event: "voice.agent.loop_failed",
      sessionId: socket.id,
      userId: state.user.id,
      correlationId,
      input: text,
      error: toErrorMessage(err)
    });
    emitError(socket, {
      message: `Assistant generation failed. Ref: ${correlationId}`,
      code: "assistant_generation_failed",
      retryable: true,
      correlationId
    });
    try {
      finalReply = await llm.generateReply(socket.id, text, (partialText) => {
        socket.emit(WS_EVENTS.AGENT_REPLY_PARTIAL, { text: partialText } satisfies AgentReplyEvent);
      });
    } catch (fallbackError) {
      emitStructuredLog("error", {
        event: "voice.agent.fallback_failed",
        sessionId: socket.id,
        userId: state.user.id,
        error: toErrorMessage(fallbackError)
      });
      finalReply = "I had trouble accessing tools just now. Please retry in a few seconds.";
    }
  }

  await emitAgentFinalAndSpeak(socket, finalReply);
}

async function handleEmailIntent(socket: Socket, state: SessionState, intent: EmailIntent): Promise<string> {
  if (intent.kind === "continue_important") {
    if (!refreshEmailStateFromWorkflow(state)) {
      return "I do not have a recent inbox triage yet. Ask me to check your emails first.";
    }
    if (state.emailConversation.phase === "idle") {
      state.emailConversation = {
        ...state.emailConversation,
        phase: "awaiting_choice"
      };
      persistEmailConversationState(state);
    }
    return buildEmailFlowPrompt(state.emailTriageCache);
  }

  const toolsByName = await composio.listToolsByUser(state.user.composioUserId);
  const triage = await gmailInboxTriage.triageInbox({
    composioUserId: state.user.composioUserId,
    toolsByName,
    resolvedQuery: intent.resolvedQuery,
    windowLabel: intent.windowLabel,
    timeZone: intent.timeZone,
    maxEmails: 2_000,
    concurrency: 6
  });

  const workflow = emailWorkflowStore.createFromTriage({
    userId: state.user.id,
    sessionId: socket.id,
    windowLabel: triage.windowLabel,
    resolvedQuery: triage.resolvedQuery,
    timeZone: triage.timeZone,
    scannedCount: triage.scannedCount,
    optionalCount: triage.optionalCount,
    capHit: triage.capHit,
    respondNeededItems: triage.respondNeeded,
    mustKnowItems: triage.mustKnow
  });
  applyWorkflowSnapshotToSessionState(state, workflow);

  emitStructuredLog("info", {
    event: "voice.gmail.triage_completed",
    sessionId: socket.id,
    userId: state.user.id,
    workflowId: workflow.workflowId,
    resolvedQuery: triage.resolvedQuery,
    timezone: triage.timeZone,
    pagesFetched: triage.pagesFetched,
    emailsFetched: triage.scannedCount,
    capHit: triage.capHit,
    durationMs: triage.durationMs,
    triageCounts: {
      respondNeeded: triage.respondNeeded.length,
      mustKnow: triage.mustKnow.length,
      optional: triage.optionalCount
    },
    llmClassifiedCount: triage.llmClassifiedCount,
    heuristicClassifiedCount: triage.heuristicClassifiedCount,
    decisionAudit: triage.decisionAudit.slice(0, 40)
  });

  if (triage.capHit) {
    emitStructuredLog("warn", {
      event: "voice.gmail.soft_cap_hit",
      sessionId: socket.id,
      userId: state.user.id,
      scannedCount: triage.scannedCount,
      cap: 2_000
    });
  }

  if (!state.emailTriageCache) {
    return "I processed your inbox, but failed to restore workflow state. Please run the triage request again.";
  }
  return buildTriageSummaryPrompt(state.emailTriageCache);
}

async function handleEmailConversationTurn(socket: Socket, state: SessionState, userText: string): Promise<string | null> {
  refreshEmailStateFromWorkflow(state);
  const cache = state.emailTriageCache;
  const flow = state.emailConversation;

  if (!cache || flow.phase === "idle") {
    return null;
  }

  const text = userText.trim();
  if (!text) {
    return null;
  }

  const decision = await llm.decideEmailWorkflowTurn({
    sessionId: socket.id,
    userText: text,
    context: buildEmailWorkflowDecisionContext(state)
  });

  if (decision.action === "handoff") {
    return null;
  }

  let rawReply = "";
  switch (decision.action) {
    case "pause": {
      state.emailConversation = createEmailConversationState();
      persistEmailConversationState(state);
      rawReply = "Okay, I paused the email flow. Ask me to check your emails again when you want to continue.";
      break;
    }
    case "summary": {
      rawReply = buildTriageSummaryPrompt(cache);
      break;
    }
    case "choose_category": {
      rawReply = selectEmailCategory(state, resolveDecisionCategory(cache, decision.category));
      break;
    }
    case "show_current_email": {
      rawReply = showCurrentEmailDetails(state, cache, decision.category);
      break;
    }
    case "next_email": {
      rawReply = advanceCurrentCategory(state);
      break;
    }
    case "draft_reply": {
      const instruction = decision.draftInstruction?.trim() || "Create the first draft.";
      return generateReplyDraftForCurrentEmail(socket.id, state, instruction);
    }
    case "revise_draft": {
      const instruction = decision.draftInstruction?.trim() || `Revise the previous draft based on: ${text}`;
      return generateReplyDraftForCurrentEmail(socket.id, state, instruction);
    }
    case "send_reply": {
      rawReply = await prepareReplyActionForCurrentEmail(socket, state, text, { autoExecute: true });
      break;
    }
    default: {
      rawReply = buildEmailFlowPrompt(cache);
      break;
    }
  }

  return llm.polishEmailWorkflowReply(text, rawReply);
}

function buildTriageSummaryPrompt(cache: EmailTriageCache): string {
  const lines: string[] = [];
  lines.push(
    `I scanned ${cache.scannedCount} unread inbox emails for ${cache.windowLabel}. ` +
      `You currently have ${cache.respondNeededCount} response-needed and ${cache.mustKnowCount} must-know emails pending. ` +
      `Optional unread emails: ${cache.optionalCount}.`
  );

  if (cache.sentCount > 0) {
    lines.push(
      `Completed in this workflow so far: ${cache.sentCount} ` +
        `(response-needed done: ${cache.respondNeededDoneCount}, must-know done: ${cache.mustKnowDoneCount}).`
    );
  }

  if (cache.capHit) {
    lines.push("I reached the safety cap of 2000 emails, so additional emails may exist beyond this scan.");
  }

  if (cache.respondNeededCount === 0 && cache.mustKnowCount === 0) {
    lines.push("No high-priority emails requiring response or awareness were detected.");
    return lines.join(" ");
  }

  lines.push("What do you want to tackle first: response-needed or must-know?");
  return lines.join(" ");
}

function buildEmailFlowPrompt(cache: EmailTriageCache | null): string {
  if (!cache) {
    return "I do not have a recent inbox triage yet. Ask me to check your emails first.";
  }
  const completed =
    cache.sentCount > 0
      ? ` Completed so far: ${cache.sentCount}.`
      : "";
  return (
    `You currently have ${cache.respondNeededCount} response-needed and ${cache.mustKnowCount} must-know unread emails.` +
    completed +
    " Say response-needed or must-know to pick one."
  );
}

function selectEmailCategory(state: SessionState, category: EmailFocusCategory): string {
  const cache = state.emailTriageCache;
  if (!cache) {
    return "I do not have triage data yet. Ask me to check your emails first.";
  }

  const items = getCategoryItems(cache, category);
  if (items.length === 0) {
    const label = category === "respond_needed" ? "response-needed" : "must-know";
    return `There are no ${label} unread emails right now. Choose the other category.`;
  }

  state.emailConversation.phase = "reviewing";
  state.emailConversation.selectedCategory = category;
  state.emailConversation.selectedIndexByCategory[category] = 0;
  state.emailConversation.currentEmailId = items[0].id;
  state.emailConversation.lastDraft = null;
  persistEmailConversationState(state);

  return buildCurrentEmailDetails(state, category);
}

function advanceCurrentCategory(state: SessionState): string {
  const category = state.emailConversation.selectedCategory;
  const cache = state.emailTriageCache;
  if (!category || !cache) {
    return buildEmailFlowPrompt(cache);
  }

  const items = getCategoryItems(cache, category);
  if (items.length === 0) {
    return "No emails are available in this category.";
  }

  const next = state.emailConversation.selectedIndexByCategory[category] + 1;
  if (next >= items.length) {
    return `No more ${category === "respond_needed" ? "response-needed" : "must-know"} emails remain. ` +
      "You can switch category or ask for a fresh triage scan.";
  }

  state.emailConversation.selectedIndexByCategory[category] = next;
  state.emailConversation.currentEmailId = items[next].id;
  state.emailConversation.lastDraft = null;
  persistEmailConversationState(state);
  return buildCurrentEmailDetails(state, category);
}

function buildCurrentEmailDetails(state: SessionState, category: EmailFocusCategory): string {
  const cache = state.emailTriageCache;
  if (!cache) {
    return "I do not have triage data yet. Ask me to check your emails first.";
  }
  const items = getCategoryItems(cache, category);
  if (items.length === 0) {
    return "No emails are available in this category.";
  }
  const index = state.emailConversation.selectedIndexByCategory[category];
  const boundedIndex = Math.max(0, Math.min(index, items.length - 1));
  const item = items[boundedIndex];
  state.emailConversation.selectedIndexByCategory[category] = boundedIndex;
  state.emailConversation.currentEmailId = item.id;
  persistEmailConversationState(state);

  const label = category === "respond_needed" ? "response-needed" : "must-know";
  const snippet = item.snippet ? `Snippet: ${compactVoiceField(item.snippet, 180)}.` : "No preview text available.";
  return (
    `${label} email ${boundedIndex + 1} of ${items.length}. ` +
    `From ${compactVoiceField(item.from, 80)}. ` +
    `Subject ${compactVoiceField(item.subject, 120)}. ` +
    `${compactVoiceField(item.reason, 120)}. ` +
    `${snippet} ` +
    "Do you want me to draft a reply now?"
  );
}

async function generateReplyDraftForCurrentEmail(sessionId: string, state: SessionState, instruction: string): Promise<string> {
  const email = getCurrentConversationEmail(state);
  if (!email) {
    return "Select an email first by saying response-needed or must-know.";
  }

  const prompt = [
    "Draft a concise email reply body only, no markdown and no extra commentary.",
    "Keep it clear, polite, and actionable.",
    "If the message asks for a decision, provide a direct and useful response.",
    `Instruction: ${instruction}`,
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Snippet: ${email.snippet || "(none)"}`,
    state.emailConversation.lastDraft ? `Previous draft: ${state.emailConversation.lastDraft}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  let draft = "";
  try {
    draft = await llm.generateReply(sessionId, prompt, () => undefined);
  } catch {
    return "I could not draft a reply right now. Please try again.";
  }

  const cleanDraft = compactVoiceField(draft, EMAIL_REPLY_DRAFT_MAX_CHARS);
  state.emailConversation.lastDraft = cleanDraft;
  persistEmailDraftInWorkflow(state, email.id, cleanDraft, instruction);
  return `${cleanDraft} Does this draft look good? If yes, I can send it now.`;
}

async function prepareReplyActionForCurrentEmail(
  socket: Socket,
  state: SessionState,
  instruction: string,
  options?: { autoExecute?: boolean }
): Promise<string> {
  const email = getCurrentConversationEmail(state);
  if (!email) {
    return "Select an email first by saying response-needed or must-know.";
  }

  let draftText = state.emailConversation.lastDraft;
  if (!draftText) {
    const draftResult = await generateReplyDraftForCurrentEmail(socket.id, state, "Create the first draft.");
    draftText = state.emailConversation.lastDraft;
    if (!draftText) {
      return draftResult;
    }
  }

  let toolsByName: Record<string, AgentToolDefinition> = {};
  try {
    toolsByName = await composio.listToolsByUser(state.user.composioUserId);
  } catch (err) {
    return `I could not load Gmail tools right now: ${toErrorMessage(err)}`;
  }

  const tool = selectGmailReplyTool(toolsByName);
  if (!tool) {
    const available = Object.values(toolsByName)
      .filter((entry) => isGmailTool(entry))
      .map((entry) => entry.toolSlug)
      .slice(0, 8);
    const suffix = available.length > 0 ? ` Available Gmail tools: ${available.join(", ")}.` : "";
    return `I can read your inbox, but I could not find a Gmail reply/send tool on your connected account.${suffix}`;
  }

  const args = buildReplyToolArgs(tool, email, draftText, instruction);
  const missingRequired = findMissingRequiredToolArgs(tool, args);
  if (missingRequired.length > 0) {
    return (
      `I found ${tool.toolSlug} but I could not map required fields (${missingRequired.join(", ")}). ` +
      "Try reconnecting Gmail in Composio and retry."
    );
  }

  const summary = `Reply to "${compactVoiceField(email.subject, 80)}" from ${compactVoiceField(email.from, 48)}`;
  const proposal = await actionOrchestrator.createProposal({
    userId: state.user.id,
    sessionId: socket.id,
    toolSlug: tool.toolSlug,
    toolkitSlug: tool.toolkitSlug,
    connectedAccountId: tool.connectedAccountId,
    summary,
    args,
    requiresApproval: true
  });
  emitActionProposed(socket, {
    draft: proposal,
    message: "Reply action prepared. Approve to send, or ask for edits."
  });
  emitActionStatus(socket, proposal, "pending_approval", "Waiting for your validation.");

  if (options?.autoExecute) {
    const executed = await executePendingAction(socket, state.user, proposal.actionId, proposal.revisionId, "voice");
    return executed;
  }

  return "Reply action is ready. Say approve to send it, or tell me what to revise.";
}

function getCurrentConversationEmail(state: SessionState): TriagedEmail | null {
  const cache = state.emailTriageCache;
  const category = state.emailConversation.selectedCategory;
  if (!cache || !category) {
    return null;
  }
  const items = getCategoryItems(cache, category);
  if (items.length === 0) {
    return null;
  }
  const index = state.emailConversation.selectedIndexByCategory[category];
  return items[Math.max(0, Math.min(index, items.length - 1))] ?? null;
}

function getCategoryItems(cache: EmailTriageCache, category: EmailFocusCategory): TriagedEmail[] {
  return category === "respond_needed" ? cache.respondNeededItems : cache.mustKnowItems;
}

function buildEmailWorkflowDecisionContext(state: SessionState): EmailWorkflowDecisionContext {
  const cache = state.emailTriageCache;
  const selectedCategory = state.emailConversation.selectedCategory;
  const currentEmail = getCurrentConversationEmail(state);

  return {
    hasActiveWorkflow: Boolean(cache),
    windowLabel: cache?.windowLabel ?? null,
    counts: {
      scanned: cache?.scannedCount ?? 0,
      respondNeeded: cache?.respondNeededCount ?? 0,
      mustKnow: cache?.mustKnowCount ?? 0,
      optional: cache?.optionalCount ?? 0,
      sent: cache?.sentCount ?? 0
    },
    selectedCategory,
    selectedIndex: selectedCategory ? state.emailConversation.selectedIndexByCategory[selectedCategory] : null,
    hasDraftForCurrentEmail: Boolean(state.emailConversation.lastDraft),
    currentEmail:
      currentEmail && selectedCategory
        ? {
            from: currentEmail.from,
            subject: currentEmail.subject,
            snippet: compactVoiceField(currentEmail.snippet || "", 220),
            category: selectedCategory
          }
        : null
  };
}

function resolveDecisionCategory(
  cache: EmailTriageCache,
  category: EmailWorkflowDecisionCategory | null
): EmailFocusCategory {
  if (category === "respond_needed" || category === "must_know") {
    return category;
  }
  if (cache.respondNeededCount > 0) {
    return "respond_needed";
  }
  return "must_know";
}

function showCurrentEmailDetails(
  state: SessionState,
  cache: EmailTriageCache,
  categoryHint: EmailWorkflowDecisionCategory | null
): string {
  const selected = state.emailConversation.selectedCategory;
  if (selected) {
    return buildCurrentEmailDetails(state, selected);
  }
  return selectEmailCategory(state, resolveDecisionCategory(cache, categoryHint));
}

function createEmailConversationState(): EmailConversationState {
  return {
    phase: "idle",
    selectedCategory: null,
    selectedIndexByCategory: {
      respond_needed: 0,
      must_know: 0
    },
    currentEmailId: null,
    lastDraft: null
  };
}

async function handlePendingVoiceTurn(
  socket: Socket,
  user: AuthenticatedUser,
  pendingDraft: { actionId: string; revisionId: string; summary: string; arguments: Record<string, unknown>; toolSlug: string },
  userText: string
): Promise<string> {
  const intent = approvalIntent.detectIntent(userText);

  if (intent.intent === "reject") {
    const rejected = await actionOrchestrator.rejectPending(socket.id, "voice", userText);
    if (!rejected) {
      return "There is no pending action to reject.";
    }
    emitActionRejected(socket, {
      actionId: rejected.actionId,
      revisionId: rejected.revisionId,
      reason: userText,
      rejectedAt: new Date().toISOString()
    });
    emitActionStatus(socket, rejected, "rejected", "Action rejected.");
    return "Okay, I rejected that action and will not execute it.";
  }

  if (intent.intent === "approve") {
    return executePendingAction(socket, user, pendingDraft.actionId, pendingDraft.revisionId, "voice");
  }

  if (intent.intent === "revise") {
    const tools = await composio.listToolsByUser(user.composioUserId);
    const tool = Object.values(tools).find((entry) => entry.toolSlug === pendingDraft.toolSlug);
    const revised = await llm.reviseDraft({
      sessionId: socket.id,
      currentSummary: pendingDraft.summary,
      currentArgs: pendingDraft.arguments,
      inputSchema: tool?.inputSchema ?? { type: "object", properties: {} },
      userInstruction: userText
    });

    const nextDraft = await actionOrchestrator.revisePending(socket.id, revised.summary, revised.args);
    if (!nextDraft) {
      return "I could not update the draft because it is no longer pending.";
    }

    emitActionRevised(socket, {
      draft: nextDraft,
      message: "Draft revised."
    });
    emitActionStatus(socket, nextDraft, "pending_approval", "Draft updated. Approve or keep revising.");
    return `Updated. ${nextDraft.summary} Tell me if you want more edits or approval.`;
  }

  return "I heard your response but I am not fully sure if you want approval, rejection, or edits. Please say it explicitly.";
}

async function handleActionApprove(socket: Socket, payload: ActionApproveEvent): Promise<void> {
  const state = ensureSessionState(socket.id);
  if (state.processing) {
    return;
  }

  state.processing = true;
  try {
    const reply = await executePendingAction(
      socket,
      state.user,
      payload.actionId,
      payload.revisionId,
      payload.source ?? "ui"
    );
    await emitAgentFinalAndSpeak(socket, reply);
  } finally {
    state.processing = false;
  }
}

async function handleActionReject(socket: Socket, payload: ActionRejectEvent): Promise<void> {
  const state = ensureSessionState(socket.id);
  if (state.processing) {
    return;
  }
  state.processing = true;
  try {
    const rejected = await actionOrchestrator.rejectPending(socket.id, payload.source ?? "ui", payload.reason ?? "rejected");
    if (!rejected) {
      await emitAgentFinalAndSpeak(socket, "There is no pending action to reject.");
      return;
    }

    emitActionRejected(socket, {
      actionId: rejected.actionId,
      revisionId: rejected.revisionId,
      reason: payload.reason ?? "Rejected from UI.",
      rejectedAt: new Date().toISOString()
    });
    emitActionStatus(socket, rejected, "rejected", "Action rejected.");
    await emitAgentFinalAndSpeak(socket, "Action rejected. Nothing was executed.");
  } finally {
    state.processing = false;
  }
}

async function executePendingAction(
  socket: Socket,
  user: AuthenticatedUser,
  actionId: string,
  revisionId: string,
  source: "voice" | "ui"
): Promise<string> {
  const result = await actionOrchestrator.approveAndExecute({
    sessionId: socket.id,
    actionId,
    revisionId,
    source,
    execute: async (draft) => {
      const tools = await composio.listToolsByUser(user.composioUserId);
      const tool = Object.values(tools).find((entry) => entry.toolSlug === draft.toolSlug);
      if (!tool) {
        throw new Error(`Connected tool ${draft.toolSlug} is currently unavailable.`);
      }
      return composio.executeTool(user.composioUserId, tool, draft.arguments);
    }
  });

  if (!result.ok) {
    const failedEvent: ActionFailedEvent = {
      actionId: result.draft?.actionId ?? null,
      revisionId: result.draft?.revisionId ?? null,
      message: result.message,
      failedAt: new Date().toISOString()
    };
    socket.emit(WS_EVENTS.ACTION_FAILED, failedEvent);
    if (result.draft) {
      emitActionStatus(socket, result.draft, "failed", result.message);
    }
    return `I could not execute that action: ${result.message}`;
  }

  const executedEvent: ActionExecutedEvent = {
    actionId: result.draft.actionId,
    revisionId: result.draft.revisionId,
    toolSlug: result.draft.toolSlug,
    resultSummary: summarizeResult(result.result),
    executedAt: new Date().toISOString()
  };
  socket.emit(WS_EVENTS.ACTION_EXECUTED, executedEvent);
  emitActionStatus(socket, result.draft, "completed", "Action executed successfully.");
  const workflowSummary = markWorkflowEmailAsSentFromAction(ensureSessionState(socket.id), result.draft);
  return workflowSummary
    ? `Done. ${executedEvent.resultSummary} ${workflowSummary}`
    : `Done. ${executedEvent.resultSummary}`;
}

async function emitAgentFinalAndSpeak(socket: Socket, finalReply: string): Promise<void> {
  const state = ensureSessionState(socket.id);
  socket.emit(WS_EVENTS.AGENT_REPLY_FINAL, { text: finalReply } satisfies AgentReplyEvent);

  const abortController = new AbortController();
  if (state.activeTtsAbortController) {
    state.activeTtsAbortController.abort("superseded");
  }
  state.activeTtsAbortController = abortController;

  try {
    const ttsResult = await tts.synthesizeWithPriority(
      finalReply,
      ({ chunk, streamId, provider, contentType }) => {
        socket.emit(
          WS_EVENTS.TTS_AUDIO_CHUNK,
          {
            streamId,
            chunkBase64: chunk.toString("base64"),
            contentType,
            provider
          } satisfies TtsAudioChunkEvent
        );
      },
      abortController.signal
    );

    socket.emit(
      WS_EVENTS.TTS_AUDIO_END,
      {
        streamId: ttsResult.streamId,
        provider: ttsResult.provider
      } satisfies TtsAudioEndEvent
    );
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    const correlationId = randomUUID();
    emitStructuredLog("error", {
      event: "voice.tts.failed",
      sessionId: socket.id,
      correlationId,
      error: toErrorMessage(err)
    });
    emitError(socket, {
      message: `Speech synthesis failed. Ref: ${correlationId}`,
      code: "tts_failed",
      retryable: true,
      correlationId
    });
  } finally {
    if (state.activeTtsAbortController === abortController) {
      state.activeTtsAbortController = null;
    }
    if (!state.processing) {
      emitSttStatus(socket, {
        code: "listening",
        message: "Listening for your request."
      });
    }
  }
}

function ensureSessionState(socketId: string): SessionState {
  const existing = sessionStateBySocketId.get(socketId);
  if (existing) {
    return existing;
  }

  const created: SessionState = {
    user: {
      id: "unknown",
      email: null,
      composioUserId: "supabase:unknown"
    },
    timeZone: "UTC",
    lastCommittedTextHash: "",
    processing: false,
    processingRunId: 0,
    activeTtsAbortController: null,
    activeEmailWorkflowId: null,
    emailTriageCache: null,
    emailConversation: createEmailConversationState(),
    recentUtteranceAtMs: []
  };
  sessionStateBySocketId.set(socketId, created);
  return created;
}

function emitSttStatus(socket: Socket, payload: SttStatusEvent): void {
  socket.emit(WS_EVENTS.STT_STATUS, payload);
}

function emitError(
  socket: Socket,
  payload: string | { message: string; code?: string; retryable?: boolean; correlationId?: string }
): void {
  const normalized: ErrorRaisedEvent =
    typeof payload === "string"
      ? {
          message: payload
        }
      : payload;
  socket.emit(WS_EVENTS.ERROR_RAISED, normalized);
}

function emitActionProposed(socket: Socket, payload: ActionProposedEvent): void {
  socket.emit(WS_EVENTS.ACTION_PROPOSED, payload);
}

function emitActionRevised(socket: Socket, payload: ActionRevisedEvent): void {
  socket.emit(WS_EVENTS.ACTION_REVISED, payload);
}

function emitActionStatus(
  socket: Socket,
  draft: { actionId: string; revisionId: string },
  status: ActionStatusEvent["status"],
  message: string
): void {
  socket.emit(
    WS_EVENTS.ACTION_STATUS,
    {
      actionId: draft.actionId,
      revisionId: draft.revisionId,
      status,
      message,
      updatedAt: new Date().toISOString()
    } satisfies ActionStatusEvent
  );
}

function emitActionRejected(socket: Socket, payload: ActionRejectedEvent): void {
  socket.emit(WS_EVENTS.ACTION_REJECTED, payload);
}

function emitAgentReplyPartial(socket: Socket, text: string): void {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return;
  }
  const chunkSize = 6;
  for (let index = 0; index < words.length; index += chunkSize) {
    socket.emit(
      WS_EVENTS.AGENT_REPLY_PARTIAL,
      {
        text: words.slice(0, index + chunkSize).join(" ")
      } satisfies AgentReplyEvent
    );
  }
}

function emitEmailProcessingAck(socket: Socket, userText: string): void {
  const ack = looksFrenchText(userText)
    ? "D'accord, je vérifie ta boîte mail."
    : "Got it. I am checking your inbox now.";
  socket.emit(WS_EVENTS.AGENT_REPLY_PARTIAL, { text: ack } satisfies AgentReplyEvent);
  socket.emit(WS_EVENTS.AGENT_REPLY_FINAL, { text: ack } satisfies AgentReplyEvent);
  emitSttStatus(socket, {
    code: "warming_up",
    message: "Processing your inbox request."
  });
}

function selectGmailReplyTool(toolsByName: Record<string, AgentToolDefinition>): AgentToolDefinition | null {
  const candidates = Object.values(toolsByName)
    .filter((tool) => tool.isMutating)
    .filter((tool) => isGmailTool(tool));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => scoreReplyTool(left.toolSlug) - scoreReplyTool(right.toolSlug));
  return candidates[0] ?? null;
}

function scoreReplyTool(toolSlug: string): number {
  const slug = toolSlug.toLowerCase();
  if (slug.includes("reply_to_thread")) {
    return 0;
  }
  if (slug.includes("reply")) {
    return 1;
  }
  if (slug.includes("send_email")) {
    return 2;
  }
  if (slug.includes("send")) {
    return 3;
  }
  return 9;
}

function isGmailTool(tool: AgentToolDefinition): boolean {
  const slug = tool.toolSlug.toLowerCase();
  if (slug.startsWith("gmail")) {
    return true;
  }
  return (tool.toolkitSlug ?? "").toLowerCase() === "gmail";
}

function buildReplyToolArgs(
  tool: AgentToolDefinition,
  email: TriagedEmail,
  draftText: string,
  instruction: string
): Record<string, unknown> {
  const schemaProperties = readToolSchemaProperties(tool.inputSchema);
  const args: Record<string, unknown> = {};
  const recipientEmail = extractEmailAddress(email.from);
  const replySubject = buildReplySubject(email.subject);

  for (const key of Object.keys(schemaProperties)) {
    const normalized = key.toLowerCase();
    if (normalized.includes("thread") && normalized.includes("id")) {
      args[key] = email.threadId ?? email.id;
      continue;
    }
    if (normalized.includes("message") && normalized.includes("id")) {
      args[key] = email.id;
      continue;
    }
    if (normalized.includes("subject")) {
      args[key] = replySubject;
      continue;
    }
    if (isRecipientKey(normalized) && recipientEmail) {
      args[key] = recipientEmail;
      continue;
    }
    if (isBodyLikeKey(normalized)) {
      args[key] = draftText;
      continue;
    }
    if (normalized.includes("instruction")) {
      args[key] = instruction;
    }
  }

  // Fallback mapping for minimal schemas.
  if (Object.keys(args).length === 0) {
    args.thread_id = email.threadId ?? email.id;
    args.message_id = email.id;
    args.body = draftText;
    if (recipientEmail) {
      args.to = recipientEmail;
    }
    args.subject = replySubject;
  }

  return args;
}

function findMissingRequiredToolArgs(tool: AgentToolDefinition, args: Record<string, unknown>): string[] {
  const required = Array.isArray((tool.inputSchema as Record<string, unknown>).required)
    ? ((tool.inputSchema as Record<string, unknown>).required as unknown[])
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  const missing: string[] = [];
  for (const key of required) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      continue;
    }
    if (value != null && typeof value !== "string") {
      continue;
    }
    missing.push(key);
  }
  return missing;
}

function readToolSchemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const raw = schema.properties;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function isBodyLikeKey(key: string): boolean {
  if (key.includes("id")) {
    return false;
  }
  return /(body|content|message|text|reply|html)/.test(key);
}

function isRecipientKey(key: string): boolean {
  if (key.includes("from")) {
    return false;
  }
  return /(to|recipient|email|address)/.test(key);
}

function extractEmailAddress(value: string): string | null {
  const bracketMatch = value.match(/<([^>]+@[^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }
  const simpleMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return simpleMatch?.[0] ? simpleMatch[0].trim() : null;
}

function buildReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re:\s/i.test(trimmed)) {
    return trimmed;
  }
  return `Re: ${trimmed}`;
}

function looksFrenchText(text: string): boolean {
  return /[àâçéèêëîïôûùüÿœ]/i.test(text) || /\b(oui|non|d'accord|mail|mails|répond|réponse|envoie|heure)\b/i.test(text);
}

function hydrateSessionFromLatestWorkflow(state: SessionState): void {
  const latest = emailWorkflowStore.getLatestByUser(state.user.id);
  if (!latest) {
    return;
  }
  applyWorkflowSnapshotToSessionState(state, latest);
}

function refreshEmailStateFromWorkflow(state: SessionState): boolean {
  if (state.activeEmailWorkflowId) {
    const active = emailWorkflowStore.getByWorkflowId(state.activeEmailWorkflowId);
    if (active) {
      applyWorkflowSnapshotToSessionState(state, active);
      return true;
    }
  }

  const latest = emailWorkflowStore.getLatestByUser(state.user.id);
  if (!latest) {
    state.activeEmailWorkflowId = null;
    state.emailTriageCache = null;
    state.emailConversation = createEmailConversationState();
    return false;
  }

  applyWorkflowSnapshotToSessionState(state, latest);
  return true;
}

function persistEmailConversationState(state: SessionState): void {
  if (!state.activeEmailWorkflowId) {
    return;
  }
  const updated = emailWorkflowStore.updateConversation(state.activeEmailWorkflowId, state.emailConversation);
  if (!updated) {
    return;
  }
  applyWorkflowSnapshotToSessionState(state, updated);
}

function persistEmailDraftInWorkflow(state: SessionState, emailId: string, draftText: string, instruction: string): void {
  if (!state.activeEmailWorkflowId) {
    return;
  }
  const updated = emailWorkflowStore.recordDraft(state.activeEmailWorkflowId, emailId, draftText, instruction);
  if (!updated) {
    return;
  }
  applyWorkflowSnapshotToSessionState(state, updated);
}

function markWorkflowEmailAsSentFromAction(
  state: SessionState,
  draft: { actionId: string; revisionId: string; toolSlug: string }
): string | null {
  if (!state.activeEmailWorkflowId) {
    return null;
  }
  if (!isGmailSendLikeTool(draft.toolSlug)) {
    return null;
  }

  const actionRef: EmailWorkflowActionRef = {
    actionId: draft.actionId,
    revisionId: draft.revisionId,
    toolSlug: draft.toolSlug
  };
  const updated = emailWorkflowStore.markCurrentEmailSent(state.activeEmailWorkflowId, actionRef);
  if (!updated) {
    return null;
  }
  applyWorkflowSnapshotToSessionState(state, updated);
  return (
    `Workflow updated. Remaining: ${updated.respondNeededCount} response-needed, ` +
    `${updated.mustKnowCount} must-know.`
  );
}

function isGmailSendLikeTool(toolSlug: string): boolean {
  const normalized = toolSlug.toLowerCase();
  if (!normalized.startsWith("gmail")) {
    return false;
  }
  return /(send|reply)/.test(normalized);
}

function applyWorkflowSnapshotToSessionState(state: SessionState, snapshot: EmailWorkflowSnapshot): void {
  state.activeEmailWorkflowId = snapshot.workflowId;
  state.emailConversation = {
    phase: snapshot.conversation.phase,
    selectedCategory: snapshot.conversation.selectedCategory,
    selectedIndexByCategory: {
      respond_needed: snapshot.conversation.selectedIndexByCategory.respond_needed,
      must_know: snapshot.conversation.selectedIndexByCategory.must_know
    },
    currentEmailId: snapshot.conversation.currentEmailId,
    lastDraft: snapshot.conversation.lastDraft
  };
  state.emailTriageCache = {
    workflowId: snapshot.workflowId,
    createdAt: snapshot.createdAt,
    windowLabel: snapshot.windowLabel,
    resolvedQuery: snapshot.resolvedQuery,
    timeZone: snapshot.timeZone,
    scannedCount: snapshot.scannedCount,
    respondNeededCount: snapshot.respondNeededCount,
    mustKnowCount: snapshot.mustKnowCount,
    respondNeededDoneCount: snapshot.respondNeededDoneCount,
    mustKnowDoneCount: snapshot.mustKnowDoneCount,
    sentCount: snapshot.sentCount,
    optionalCount: snapshot.optionalCount,
    capHit: snapshot.capHit,
    respondNeededItems: snapshot.respondNeededItems,
    mustKnowItems: snapshot.mustKnowItems
  };
}

function normalizeHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "Unknown error";
}

function summarizeResult(result: unknown): string {
  if (result == null) {
    return "Execution completed.";
  }
  if (typeof result === "string") {
    return result.length > 220 ? `${result.slice(0, 220)}...` : result;
  }
  if (Array.isArray(result)) {
    return `Execution completed with ${result.length} item(s).`;
  }
  if (typeof result === "object") {
    const keys = Object.keys(result as Record<string, unknown>);
    if (keys.length === 0) {
      return "Execution completed.";
    }
    return `Execution completed. Returned fields: ${keys.slice(0, 6).join(", ")}.`;
  }
  return `Execution completed with result: ${String(result)}`;
}

function parseConnectLinkBody(value: unknown): { ok: true; value: { authConfigId: string } } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const authConfigId = String((value as Record<string, unknown>).authConfigId ?? "").trim();
  if (!authConfigId) {
    return { ok: false, message: "authConfigId is required." };
  }
  if (authConfigId.length > MAX_AUTH_CONFIG_ID_LENGTH) {
    return { ok: false, message: "authConfigId is too long." };
  }
  return {
    ok: true,
    value: {
      authConfigId
    }
  };
}

function parseTelemetryEvent(value: unknown): { ok: true; value: TelemetryEventRequest } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const event = String((value as Record<string, unknown>).event ?? "").trim() as TelemetryEventName;
  if (!TELEMETRY_EVENTS.has(event)) {
    return { ok: false, message: "Unsupported telemetry event." };
  }
  const metadataRaw = (value as Record<string, unknown>).metadata;
  const metadata = isPlainObject(metadataRaw) ? metadataRaw : undefined;

  return {
    ok: true,
    value: {
      event,
      metadata
    }
  };
}

function parseAudioUserUtterance(
  value: unknown
): { ok: true; value: AudioUserUtteranceEvent } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Utterance payload must be an object." };
  }
  const payload = value as Record<string, unknown>;
  const audioBase64 = typeof payload.audioBase64 === "string" ? payload.audioBase64.trim() : "";
  const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
  const sampleRate = Number(payload.sampleRate);

  if (!audioBase64) {
    return { ok: false, message: "audioBase64 is required." };
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(audioBase64)) {
    return { ok: false, message: "audioBase64 must be valid base64 content." };
  }
  if (mimeType !== "audio/mpeg") {
    return { ok: false, message: "mimeType must be audio/mpeg." };
  }
  if (sampleRate !== 16000) {
    return { ok: false, message: "sampleRate must be 16000." };
  }
  if (audioBase64.length > 10_000_000) {
    return { ok: false, message: "audio payload is too large." };
  }

  return {
    ok: true,
    value: {
      audioBase64,
      mimeType,
      sampleRate: 16000
    }
  };
}

function parseActionApprove(value: unknown): { ok: true; value: ActionApproveEvent } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Approve payload must be an object." };
  }
  const payload = value as Record<string, unknown>;
  const actionId = typeof payload.actionId === "string" ? payload.actionId.trim() : "";
  const revisionId = typeof payload.revisionId === "string" ? payload.revisionId.trim() : "";
  const source = payload.source === "voice" || payload.source === "ui" ? payload.source : "ui";

  if (!actionId || !revisionId) {
    return { ok: false, message: "actionId and revisionId are required." };
  }

  return {
    ok: true,
    value: {
      actionId,
      revisionId,
      source
    }
  };
}

function parseActionReject(value: unknown): { ok: true; value: ActionRejectEvent } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Reject payload must be an object." };
  }
  const payload = value as Record<string, unknown>;
  const actionId = typeof payload.actionId === "string" ? payload.actionId.trim() : "";
  const revisionId = typeof payload.revisionId === "string" ? payload.revisionId.trim() : "";
  const source = payload.source === "voice" || payload.source === "ui" ? payload.source : "ui";
  const reason =
    typeof payload.reason === "string"
      ? payload.reason.trim().slice(0, MAX_REASON_LENGTH)
      : undefined;

  if (!actionId || !revisionId) {
    return { ok: false, message: "actionId and revisionId are required." };
  }

  return {
    ok: true,
    value: {
      actionId,
      revisionId,
      source,
      reason
    }
  };
}

function isSocketRateLimited(state: SessionState): boolean {
  const now = Date.now();
  const threshold = now - 60_000;
  state.recentUtteranceAtMs = state.recentUtteranceAtMs.filter((timestamp) => timestamp >= threshold);
  if (state.recentUtteranceAtMs.length >= env.socketUtteranceRateLimitPerMinute) {
    return true;
  }
  state.recentUtteranceAtMs.push(now);
  return false;
}

function resolveBillingPlan(user: AuthenticatedUser): typeof BILLING_PAID | typeof BILLING_TRIAL {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (email && env.paidUserEmails.includes(email)) {
    return BILLING_PAID;
  }
  return BILLING_TRIAL;
}

function emitStructuredLog(level: "info" | "warn" | "error", payload: Record<string, unknown>): void {
  const formatted = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...payload
  });
  if (level === "error") {
    console.error(formatted);
    return;
  }
  if (level === "warn") {
    console.warn(formatted);
    return;
  }
  console.log(formatted);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickConnectionId(query: Request["query"]): string | null {
  const candidates = ["connectedAccountId", "connectionId", "id", "nanoid"];
  for (const key of candidates) {
    const value = query[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function readSocketTimeZone(socket: Socket): string {
  const authPayload = (socket.handshake.auth ?? {}) as Partial<VoiceSessionSocketAuth>;
  return normalizeTimeZone(authPayload.timeZone ?? null);
}

function readSocketAccessToken(socket: Socket): string | null {
  const authPayload = (socket.handshake.auth ?? {}) as Partial<VoiceSessionSocketAuth>;
  const authToken = authPayload.accessToken;
  if (typeof authToken === "string" && authToken.length > 0) {
    return authToken;
  }

  const headerToken = getBearerToken(socket.handshake.headers.authorization);
  if (headerToken) {
    return headerToken;
  }
  return null;
}

function compactVoiceField(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxChars - 15))}...(truncated)`;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError";
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

async function requireHttpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await auth.requireRequestUser(req);
    (req as AuthedRequest).authUser = user;
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ message: err.message });
      return;
    }
    res.status(401).json({ message: "Unauthorized." });
  }
}

httpServer.listen(env.port, () => {
  emitStructuredLog("info", {
    event: "server.started",
    port: env.port
  });
});
