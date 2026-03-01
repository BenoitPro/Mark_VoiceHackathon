import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import {
  WS_EVENTS,
  type ActionApproveEvent,
  type ActionDraft,
  type ActionExecutedEvent,
  type ActionFailedEvent,
  type ActionProposedEvent,
  type ActionRejectEvent,
  type ActionRejectedEvent,
  type ActionRevisedEvent,
  type ActionStatusEvent,
  type AgentReplyEvent,
  type AudioUserUtteranceEvent,
  type SessionStartedEvent,
  type SttStatusEvent,
  type TranscriptEvent,
  type TtsAudioChunkEvent,
  type TtsAudioEndEvent,
  type TtsProvider,
  type VoiceState
} from "@mark/contracts";

import { MicrophonePipeline } from "./audio";
import { encodePcmChunksToMp3Base64 } from "./mp3";
import { StreamingTtsPlayer } from "./ttsPlayer";

type VoiceHealth = {
  sttConfigured: boolean;
  ttsConfigured: boolean;
  ttsProviders?: {
    speechmaticsConfigured: boolean;
    elevenLabsConfigured: boolean;
    priority: Array<"speechmatics" | "elevenlabs">;
  };
  llmConfigured: boolean;
  authConfigured: boolean;
  composioConfigured: boolean;
  lastSttErrorAt: string | null;
  lastTtsErrorAt: string | null;
};

export type ActionTimelineItem = {
  id: string;
  actionId: string | null;
  revisionId: string | null;
  type: string;
  message: string;
  createdAt: string;
};

type VoiceAgentState = {
  connected: boolean;
  voiceState: VoiceState;
  sttStatus: SttStatusEvent | null;
  userPartial: string;
  userFinal: string;
  agentPartial: string;
  agentFinal: string;
  audioLevel: number;
  error: string | null;
  sessionId: string | null;
  health: VoiceHealth | null;
  isRunning: boolean;
  pendingAction: ActionDraft | null;
  actionStatus: ActionStatusEvent | null;
  actionTimeline: ActionTimelineItem[];
  activeTtsProvider: TtsProvider | null;
};

type VoiceAgentApi = VoiceAgentState & {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  resetMemory: () => void;
  approvePending: () => void;
  rejectPending: (reason?: string) => void;
};

const SILENCE_THRESHOLD = 0.015;
const SILENCE_COMMIT_MS = 900;
const SAMPLE_RATE: 16000 = 16000;
const PRE_ROLL_CHUNKS = 4;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export function useVoiceAgent(audioElement: HTMLAudioElement | null, accessToken: string | null): VoiceAgentApi {
  const [connected, setConnected] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [sttStatus, setSttStatus] = useState<SttStatusEvent | null>(null);
  const [userPartial, setUserPartial] = useState("");
  const [userFinal, setUserFinal] = useState("");
  const [agentPartial, setAgentPartial] = useState("");
  const [agentFinal, setAgentFinal] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [health, setHealth] = useState<VoiceHealth | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<ActionDraft | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatusEvent | null>(null);
  const [actionTimeline, setActionTimeline] = useState<ActionTimelineItem[]>([]);
  const [activeTtsProvider, setActiveTtsProvider] = useState<TtsProvider | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const micRef = useRef<MicrophonePipeline | null>(null);
  const playerRef = useRef<StreamingTtsPlayer | null>(null);
  const voiceStateRef = useRef<VoiceState>("idle");
  const smoothedLevelRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const awaitingCommitRef = useRef(false);
  const speechDetectedRef = useRef(false);
  const utteranceChunksRef = useRef<Int16Array[]>([]);
  const preRollRef = useRef<Int16Array[]>([]);

  const setVoiceStateSafe = (next: VoiceState): void => {
    voiceStateRef.current = next;
    setVoiceState(next);
  };

  const pushTimeline = (
    type: string,
    message: string,
    actionId: string | null = null,
    revisionId: string | null = null
  ): void => {
    const now = new Date().toISOString();
    setActionTimeline((prev) => [
      {
        id: `${type}-${now}-${Math.random().toString(16).slice(2)}`,
        actionId,
        revisionId,
        type,
        message,
        createdAt: now
      },
      ...prev
    ]);
  };

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  useEffect(() => {
    void fetch(`${API_BASE_URL}/health/voice`)
      .then((response) => response.json())
      .then((data: VoiceHealth) => {
        setHealth(data);
      })
      .catch(() => {
        setHealth(null);
      });
  }, []);

  useEffect(() => {
    if (!audioElement) {
      return;
    }

    const player = new StreamingTtsPlayer(audioElement, (isPlaying) => {
      if (isPlaying) {
        setVoiceStateSafe("speaking");
      } else {
        setVoiceStateSafe(connected ? "listening" : "idle");
      }
    });

    playerRef.current = player;

    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [audioElement, connected]);

  const connectSocket = (): void => {
    if (socketRef.current) {
      return;
    }
    if (!accessToken) {
      setError("Sign in is required before opening the voice session.");
      return;
    }

    const socket = io(`${API_BASE_URL}/v1/session`, {
      transports: ["websocket"],
      auth: {
        accessToken
      }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setError(null);
      setVoiceStateSafe("listening");
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setVoiceStateSafe("idle");
      setSessionId(null);
      setActiveTtsProvider(null);
    });

    socket.on("connect_error", (err) => {
      setError(err.message || "Connection failed.");
      setConnected(false);
      setVoiceStateSafe("idle");
    });

    socket.on(WS_EVENTS.SESSION_STARTED, (payload: SessionStartedEvent) => {
      setSessionId(payload.sessionId);
      setAgentFinal(payload.greeting);
      setAgentPartial("");
      setVoiceStateSafe("listening");
    });

    socket.on(WS_EVENTS.STT_STATUS, (payload: SttStatusEvent) => {
      setSttStatus(payload);
      if (payload.code === "listening" && voiceStateRef.current !== "speaking") {
        setVoiceStateSafe("listening");
      }
      if (payload.code === "provider_error") {
        setError(payload.message);
      }
    });

    socket.on(WS_EVENTS.STT_PARTIAL, (payload: TranscriptEvent) => {
      setUserPartial(payload.text);
      if (voiceStateRef.current !== "speaking") {
        setVoiceStateSafe("listening");
      }
    });

    socket.on(WS_EVENTS.STT_FINAL, (payload: TranscriptEvent) => {
      setUserFinal(payload.text);
      setUserPartial("");
      setVoiceStateSafe("thinking");
    });

    socket.on(WS_EVENTS.AGENT_REPLY_PARTIAL, (payload: AgentReplyEvent) => {
      setAgentPartial(payload.text);
      if (voiceStateRef.current !== "speaking") {
        setVoiceStateSafe("thinking");
      }
    });

    socket.on(WS_EVENTS.AGENT_REPLY_FINAL, (payload: AgentReplyEvent) => {
      setAgentFinal(payload.text);
      setAgentPartial("");
      if (voiceStateRef.current !== "speaking") {
        setVoiceStateSafe("thinking");
      }
    });

    socket.on(WS_EVENTS.TTS_AUDIO_CHUNK, (payload: TtsAudioChunkEvent) => {
      setActiveTtsProvider(payload.provider);
      playerRef.current?.enqueueChunk(payload.streamId, payload.chunkBase64, payload.contentType);
    });

    socket.on(WS_EVENTS.TTS_AUDIO_END, (payload: TtsAudioEndEvent) => {
      setActiveTtsProvider(payload.provider);
      playerRef.current?.endStream(payload.streamId);
    });

    socket.on(WS_EVENTS.ACTION_PROPOSED, (payload: ActionProposedEvent) => {
      setPendingAction(payload.draft);
      pushTimeline("action.proposed", payload.message, payload.draft.actionId, payload.draft.revisionId);
    });

    socket.on(WS_EVENTS.ACTION_REVISED, (payload: ActionRevisedEvent) => {
      setPendingAction(payload.draft);
      pushTimeline("action.revised", payload.message, payload.draft.actionId, payload.draft.revisionId);
    });

    socket.on(WS_EVENTS.ACTION_STATUS, (payload: ActionStatusEvent) => {
      setActionStatus(payload);
      pushTimeline("action.status", payload.message, payload.actionId, payload.revisionId);
    });

    socket.on(WS_EVENTS.ACTION_EXECUTED, (payload: ActionExecutedEvent) => {
      setPendingAction((current) => (current?.actionId === payload.actionId ? null : current));
      pushTimeline("action.executed", payload.resultSummary, payload.actionId, payload.revisionId);
    });

    socket.on(WS_EVENTS.ACTION_REJECTED, (payload: ActionRejectedEvent) => {
      setPendingAction((current) => (current?.actionId === payload.actionId ? null : current));
      pushTimeline("action.rejected", payload.reason, payload.actionId, payload.revisionId);
    });

    socket.on(WS_EVENTS.ACTION_FAILED, (payload: ActionFailedEvent) => {
      setPendingAction((current) => (current?.actionId === payload.actionId ? null : current));
      pushTimeline("action.failed", payload.message, payload.actionId, payload.revisionId);
      setError(payload.message);
    });

    socket.on(WS_EVENTS.ERROR_RAISED, (payload: { message: string }) => {
      setError(payload.message);
      if (voiceStateRef.current !== "speaking") {
        setVoiceStateSafe("idle");
      }
    });
  };

  const disconnectSocket = (): void => {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.removeAllListeners();
    socket.disconnect();
    socketRef.current = null;
    setConnected(false);
  };

  const start = async (): Promise<void> => {
    if (isRunning) {
      return;
    }
    if (!accessToken) {
      setError("Sign in is required before starting the voice agent.");
      return;
    }

    setError(null);
    connectSocket();

    const mic = new MicrophonePipeline(({ pcm16, rms }) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        return;
      }

      if (voiceStateRef.current === "speaking" || voiceStateRef.current === "thinking") {
        return;
      }

      smoothedLevelRef.current = smoothedLevelRef.current * 0.3 + rms * 0.7;
      setAudioLevel(smoothedLevelRef.current);
      const chunkCopy = new Int16Array(pcm16);
      appendPreRoll(chunkCopy, preRollRef.current);

      const now = Date.now();
      const hasVoice = smoothedLevelRef.current > SILENCE_THRESHOLD;

      if (hasVoice) {
        if (!speechDetectedRef.current) {
          speechDetectedRef.current = true;
          utteranceChunksRef.current = preRollRef.current.map((chunk) => new Int16Array(chunk));
          setUserPartial("Listening...");
        }
        lastVoiceAtRef.current = now;
        awaitingCommitRef.current = true;
      }

      if (speechDetectedRef.current) {
        utteranceChunksRef.current.push(chunkCopy);
      }

      if (
        awaitingCommitRef.current &&
        lastVoiceAtRef.current > 0 &&
        now - lastVoiceAtRef.current >= SILENCE_COMMIT_MS &&
        speechDetectedRef.current
      ) {
        awaitingCommitRef.current = false;
        speechDetectedRef.current = false;
        preRollRef.current = [];
        setUserPartial("");
        setVoiceStateSafe("thinking");

        const utterance = utteranceChunksRef.current;
        utteranceChunksRef.current = [];
        void sendUtterance(socket, utterance, setSttStatus, setError);
      }
    });

    try {
      await mic.start();
      micRef.current = mic;
      setIsRunning(true);
      setVoiceStateSafe("listening");
      setSttStatus({
        code: "listening",
        message: "Listening for your request."
      });
    } catch {
      await mic.stop().catch(() => undefined);
      setError("Microphone permission is required.");
      setSttStatus({
        code: "mic_inactive",
        message: "Microphone permission is required."
      });
      setVoiceStateSafe("idle");
    }
  };

  const stop = async (): Promise<void> => {
    setIsRunning(false);
    setAudioLevel(0);
    awaitingCommitRef.current = false;
    smoothedLevelRef.current = 0;
    lastVoiceAtRef.current = 0;
    speechDetectedRef.current = false;
    utteranceChunksRef.current = [];
    preRollRef.current = [];
    setUserPartial("");

    const mic = micRef.current;
    micRef.current = null;
    if (mic) {
      await mic.stop().catch(() => undefined);
    }

    playerRef.current?.stop();
    setActiveTtsProvider(null);
    disconnectSocket();
    setVoiceStateSafe("idle");
  };

  const resetMemory = (): void => {
    socketRef.current?.emit(WS_EVENTS.SESSION_RESET, {});
    setAgentPartial("");
    setAgentFinal("Memory cleared.");
    setUserPartial("");
    setUserFinal("");
    setPendingAction(null);
    setActionStatus(null);
    setActiveTtsProvider(null);
  };

  const approvePending = (): void => {
    const draft = pendingAction;
    if (!draft) {
      return;
    }
    socketRef.current?.emit(
      WS_EVENTS.ACTION_APPROVE,
      {
        actionId: draft.actionId,
        revisionId: draft.revisionId,
        source: "ui"
      } satisfies ActionApproveEvent
    );
  };

  const rejectPending = (reason?: string): void => {
    const draft = pendingAction;
    if (!draft) {
      return;
    }
    socketRef.current?.emit(
      WS_EVENTS.ACTION_REJECT,
      {
        actionId: draft.actionId,
        revisionId: draft.revisionId,
        reason,
        source: "ui"
      } satisfies ActionRejectEvent
    );
  };

  useEffect(() => {
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accessToken && isRunning) {
      void stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  return useMemo(
    () => ({
      connected,
      voiceState,
      sttStatus,
      userPartial,
      userFinal,
      agentPartial,
      agentFinal,
      audioLevel,
      error,
      sessionId,
      health,
      isRunning,
      pendingAction,
      actionStatus,
      actionTimeline,
      activeTtsProvider,
      start,
      stop,
      resetMemory,
      approvePending,
      rejectPending
    }),
    [
      connected,
      voiceState,
      sttStatus,
      userPartial,
      userFinal,
      agentPartial,
      agentFinal,
      audioLevel,
      error,
      sessionId,
      health,
      isRunning,
      pendingAction,
      actionStatus,
      actionTimeline,
      activeTtsProvider
    ]
  );
}

async function sendUtterance(
  socket: Socket,
  chunks: Int16Array[],
  setSttStatus: (value: SttStatusEvent | null) => void,
  setError: (value: string | null) => void
): Promise<void> {
  if (chunks.length === 0) {
    return;
  }

  try {
    const audioBase64 = encodePcmChunksToMp3Base64(chunks, SAMPLE_RATE);
    if (!audioBase64) {
      return;
    }

    setSttStatus({
      code: "warming_up",
      message: "Sending your utterance."
    });

    socket.emit(
      WS_EVENTS.AUDIO_USER_UTTERANCE,
      {
        audioBase64,
        mimeType: "audio/mpeg",
        sampleRate: SAMPLE_RATE
      } satisfies AudioUserUtteranceEvent
    );
  } catch {
    setError("Failed to encode voice utterance.");
    setSttStatus({
      code: "provider_error",
      message: "Failed to prepare voice audio."
    });
  }
}

function appendPreRoll(chunk: Int16Array, target: Int16Array[]): void {
  target.push(chunk);
  while (target.length > PRE_ROLL_CHUNKS) {
    target.shift();
  }
}
