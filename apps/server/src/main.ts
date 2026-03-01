import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";

import {
  WS_EVENTS,
  type ActionApproveEvent,
  type ActionExecutedEvent,
  type ActionFailedEvent,
  type ActionHistoryResponse,
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
  type SessionStartedEvent,
  type SttStatusEvent,
  type TranscriptEvent,
  type TtsAudioChunkEvent,
  type TtsAudioEndEvent
} from "@mark/contracts";

import { ActionOrchestrator } from "./actionOrchestrator.js";
import { AnthropicService } from "./anthropic.js";
import { ApprovalIntentService } from "./approvalIntent.js";
import { AuthError, AuthService, getBearerToken, type AuthenticatedUser } from "./auth.js";
import { AuditService } from "./audit.js";
import { ComposioService } from "./composio.js";
import { ElevenLabsService } from "./elevenlabs.js";
import { getEnvConfig } from "./env.js";
import { SpeechmaticsAdapter } from "./speechmatics.js";
import { SpeechmaticsTtsService } from "./speechmaticsTts.js";
import { TtsRouter } from "./ttsRouter.js";

type SessionState = {
  user: AuthenticatedUser;
  lastCommittedTextHash: string;
  processing: boolean;
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

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(
  cors({
    origin: env.webOrigin,
    credentials: false
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

app.get("/v1/auth/me", requireHttpAuth, (req, res) => {
  const { authUser } = req as AuthedRequest;
  res.json({
    userId: authUser.id,
    email: authUser.email
  } satisfies AuthMeResponse);
});

app.get("/v1/composio/catalog", requireHttpAuth, async (_req, res) => {
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
});

app.post("/v1/composio/connect-link", requireHttpAuth, async (req, res) => {
  const { authUser } = req as AuthedRequest;
  const authConfigId = readRequiredString(req.body, "authConfigId");
  if (!authConfigId) {
    res.status(400).json({ message: "authConfigId is required." });
    return;
  }

  try {
    const result = await composio.createConnectLink(authUser.composioUserId, authConfigId);
    res.json({
      redirectUrl: result.redirectUrl,
      connectionRequestId: result.connectionRequestId
    } satisfies ComposioConnectLinkResponse);
  } catch (err) {
    res.status(500).json({ message: toErrorMessage(err) });
  }
});

app.get("/v1/composio/connections", requireHttpAuth, async (req, res) => {
  const { authUser } = req as AuthedRequest;
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
  const items = await audit.listHistory(authUser.id);
  res.json({ items } satisfies ActionHistoryResponse);
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
  sessionStateBySocketId.set(socket.id, {
    user,
    lastCommittedTextHash: "",
    processing: false
  });

  const startedPayload: SessionStartedEvent = {
    sessionId: socket.id,
    greeting: "Ready. I can now read data and prepare actions with your approval."
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

  socket.on(WS_EVENTS.AUDIO_USER_UTTERANCE, (payload: AudioUserUtteranceEvent) => {
    void handleUserUtterance(socket, payload);
  });

  // Keep this event for compatibility, but the active path is utterance upload.
  socket.on(WS_EVENTS.AUDIO_USER_CHUNK, (_payload: AudioUserChunkEvent) => {
    emitError(socket, "Streaming chunk mode is disabled. Please use utterance mode.");
  });

  socket.on(WS_EVENTS.STT_FINAL, (payload: TranscriptEvent) => {
    void processFinalTranscript(socket, payload.text);
  });

  socket.on(WS_EVENTS.ACTION_APPROVE, (payload: ActionApproveEvent) => {
    void handleActionApprove(socket, payload);
  });

  socket.on(WS_EVENTS.ACTION_REJECT, (payload: ActionRejectEvent) => {
    void handleActionReject(socket, payload);
  });

  socket.on(WS_EVENTS.SESSION_RESET, () => {
    const state = ensureSessionState(socket.id);
    state.lastCommittedTextHash = "";
    llm.clearSession(socket.id);
    actionOrchestrator.clearSession(socket.id);
    emitSttStatus(socket, {
      code: "listening",
      message: "Memory cleared. Listening."
    });
  });

  socket.on("disconnect", () => {
    sessionStateBySocketId.delete(socket.id);
    actionOrchestrator.clearSession(socket.id);
    llm.clearSession(socket.id);
  });
});

async function handleUserUtterance(socket: Socket, payload: AudioUserUtteranceEvent): Promise<void> {
  const state = ensureSessionState(socket.id);
  if (state.processing) {
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
    emitError(socket, "Invalid utterance payload.");
    return;
  }

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
    console.error("[voice][stt] utterance processing failed", {
      sessionId: socket.id,
      userId: state.user.id,
      error: toErrorMessage(err)
    });
    emitError(socket, `Speech transcription failed: ${toErrorMessage(err)}`);
    emitSttStatus(socket, {
      code: "provider_error",
      message: "Speech transcription failed."
    });
  } finally {
    state.processing = false;
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

  let finalReply = "";
  try {
    let toolsByName: Record<string, Awaited<ReturnType<typeof composio.listToolsByUser>>[string]> = {};
    try {
      toolsByName = await composio.listToolsByUser(state.user.composioUserId);
    } catch (toolCatalogError) {
      console.error("[voice][tools] failed to list tools", {
        sessionId: socket.id,
        userId: state.user.id,
        error: toErrorMessage(toolCatalogError)
      });
      emitError(socket, `Tool catalog unavailable: ${toErrorMessage(toolCatalogError)}`);
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
    console.error("[voice][agent] llm/action loop failed", {
      sessionId: socket.id,
      userId: state.user.id,
      input: text,
      error: toErrorMessage(err)
    });
    emitError(socket, `LLM/action loop failed: ${toErrorMessage(err)}`);
    try {
      finalReply = await llm.generateReply(socket.id, text, (partialText) => {
        socket.emit(WS_EVENTS.AGENT_REPLY_PARTIAL, { text: partialText } satisfies AgentReplyEvent);
      });
    } catch (fallbackError) {
      console.error("[voice][agent] fallback reply failed", {
        sessionId: socket.id,
        userId: state.user.id,
        error: toErrorMessage(fallbackError)
      });
      finalReply = "I had trouble accessing tools just now. Please retry in a few seconds.";
    }
  }

  await emitAgentFinalAndSpeak(socket, finalReply);
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
  return `Done. ${executedEvent.resultSummary}`;
}

async function emitAgentFinalAndSpeak(socket: Socket, finalReply: string): Promise<void> {
  socket.emit(WS_EVENTS.AGENT_REPLY_FINAL, { text: finalReply } satisfies AgentReplyEvent);

  try {
    const ttsResult = await tts.synthesizeWithPriority(finalReply, ({ chunk, streamId, provider, contentType }) => {
      socket.emit(
        WS_EVENTS.TTS_AUDIO_CHUNK,
        {
          streamId,
          chunkBase64: chunk.toString("base64"),
          contentType,
          provider
        } satisfies TtsAudioChunkEvent
      );
    });

    socket.emit(
      WS_EVENTS.TTS_AUDIO_END,
      {
        streamId: ttsResult.streamId,
        provider: ttsResult.provider
      } satisfies TtsAudioEndEvent
    );
  } catch (err) {
    console.error("[voice][tts] synthesis failed", {
      sessionId: socket.id,
      error: toErrorMessage(err)
    });
    emitError(socket, `TTS failed: ${toErrorMessage(err)}`);
  } finally {
    emitSttStatus(socket, {
      code: "listening",
      message: "Listening for your request."
    });
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
    lastCommittedTextHash: "",
    processing: false
  };
  sessionStateBySocketId.set(socketId, created);
  return created;
}

function emitSttStatus(socket: Socket, payload: SttStatusEvent): void {
  socket.emit(WS_EVENTS.STT_STATUS, payload);
}

function emitError(socket: Socket, message: string): void {
  socket.emit(WS_EVENTS.ERROR_RAISED, { message } satisfies ErrorRaisedEvent);
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

function readRequiredString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
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

function readSocketAccessToken(socket: Socket): string | null {
  const authToken = socket.handshake.auth?.accessToken;
  if (typeof authToken === "string" && authToken.length > 0) {
    return authToken;
  }

  const headerToken = getBearerToken(socket.handshake.headers.authorization);
  if (headerToken) {
    return headerToken;
  }
  return null;
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
  console.log(`server listening on http://localhost:${env.port}`);
});
