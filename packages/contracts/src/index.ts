export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export interface SessionStartedEvent {
  sessionId: string;
  greeting: string;
}

export interface VoiceSessionSocketAuth {
  accessToken: string;
  timeZone?: string;
}

export type ApprovalSource = "voice" | "ui";
export type ActionLifecycleStatus =
  | "idle"
  | "pending_proposal"
  | "pending_approval"
  | "executing"
  | "completed"
  | "rejected"
  | "failed";

export interface ActionDraft {
  actionId: string;
  revisionId: string;
  status: ActionLifecycleStatus;
  toolSlug: string;
  toolkitSlug: string | null;
  connectedAccountId: string | null;
  summary: string;
  arguments: Record<string, unknown>;
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AudioUserChunkEvent {
  chunkBase64: string;
  sampleRate: 16000;
  commit?: boolean;
}

export interface AudioUserUtteranceEvent {
  audioBase64: string;
  mimeType: "audio/mpeg";
  sampleRate: 16000;
}

export interface TranscriptEvent {
  text: string;
}

export interface AgentReplyEvent {
  text: string;
}

export type TtsProvider = "speechmatics" | "elevenlabs";

export interface TtsAudioChunkEvent {
  streamId: string;
  chunkBase64: string;
  contentType: "audio/mpeg" | "audio/wav";
  provider: TtsProvider;
}

export interface TtsAudioEndEvent {
  streamId: string;
  provider: TtsProvider;
}

export type SttStatusCode = "warming_up" | "listening" | "provider_error" | "mic_inactive";

export interface SttStatusEvent {
  code: SttStatusCode;
  message: string;
}

export interface ErrorRaisedEvent {
  message: string;
  code?: string;
  retryable?: boolean;
  correlationId?: string;
}

export interface SessionResetEvent {
  hard?: boolean;
}

export interface ActionProposedEvent {
  draft: ActionDraft;
  message: string;
}

export interface ActionRevisedEvent {
  draft: ActionDraft;
  message: string;
}

export interface ActionStatusEvent {
  actionId: string;
  revisionId: string;
  status: ActionLifecycleStatus;
  message: string;
  updatedAt: string;
}

export interface ActionExecutedEvent {
  actionId: string;
  revisionId: string;
  toolSlug: string;
  resultSummary: string;
  executedAt: string;
}

export interface ActionRejectedEvent {
  actionId: string;
  revisionId: string;
  reason: string;
  rejectedAt: string;
}

export interface ActionFailedEvent {
  actionId: string | null;
  revisionId: string | null;
  message: string;
  failedAt: string;
}

export interface ActionApproveEvent {
  actionId: string;
  revisionId: string;
  source?: ApprovalSource;
}

export interface ActionRejectEvent {
  actionId: string;
  revisionId: string;
  reason?: string;
  source?: ApprovalSource;
}

export interface AuthMeResponse {
  userId: string;
  email: string | null;
}

export interface ComposioCatalogItem {
  authConfigId: string;
  name: string;
  toolkitSlug: string;
  toolkitName: string;
  authScheme: string | null;
  isComposioManaged: boolean;
}

export interface ComposioConnectLinkResponse {
  redirectUrl: string;
  connectionRequestId: string;
}

export interface ComposioConnectionItem {
  connectedAccountId: string;
  authConfigId: string | null;
  authConfigName: string | null;
  toolkitSlug: string;
  toolkitName: string;
  status: string;
}

export interface ActionHistoryItem {
  id: string;
  actionId: string | null;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ActionHistoryResponse {
  items: ActionHistoryItem[];
}

export type BillingPlan = "trial" | "paid";

export interface BillingStatusResponse {
  plan: BillingPlan;
  checkoutConfigured: boolean;
  checkoutUrl: string | null;
}

export interface BillingCheckoutResponse {
  checkoutUrl: string;
}

export type TelemetryEventName = "visit" | "signup" | "gmail_connected" | "first_triage" | "checkout_clicked";

export interface TelemetryEventRequest {
  event: TelemetryEventName;
  metadata?: Record<string, unknown>;
}

export const WS_EVENTS = {
  SESSION_STARTED: "session.started",
  AUDIO_USER_CHUNK: "audio.user.chunk",
  AUDIO_USER_UTTERANCE: "audio.user.utterance",
  STT_PARTIAL: "stt.partial",
  STT_FINAL: "stt.final",
  STT_STATUS: "stt.status",
  AGENT_REPLY_PARTIAL: "agent.reply.partial",
  AGENT_REPLY_FINAL: "agent.reply.final",
  TTS_AUDIO_CHUNK: "tts.audio.chunk",
  TTS_AUDIO_END: "tts.audio.end",
  ACTION_PROPOSED: "action.proposed",
  ACTION_REVISED: "action.revised",
  ACTION_STATUS: "action.status",
  ACTION_EXECUTED: "action.executed",
  ACTION_REJECTED: "action.rejected",
  ACTION_FAILED: "action.failed",
  ACTION_APPROVE: "action.approve",
  ACTION_REJECT: "action.reject",
  ERROR_RAISED: "error.raised",
  SESSION_RESET: "session.reset"
} as const;

export type WsEventName = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];
