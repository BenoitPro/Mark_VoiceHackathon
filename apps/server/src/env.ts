import { config as loadDotenv } from "dotenv";
import path from "node:path";

for (const candidate of [
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "apps/server/.env.local"),
  path.resolve(process.cwd(), "apps/server/.env")
]) {
  loadDotenv({ path: candidate, quiet: true });
}

type EnvConfig = {
  port: number;
  webOrigin: string;
  webOrigins: string[];
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  supabaseServiceRoleKey: string | null;
  composioApiKey: string | null;
  composioBaseUrl: string;
  composioConnectCallbackUrl: string;
  anthropicApiKey: string | null;
  anthropicModel: string;
  speechmaticsApiKey: string | null;
  speechmaticsApiBaseUrl: string;
  speechmaticsTtsBaseUrl: string;
  speechmaticsTtsVoice: string;
  speechmaticsTtsOutputFormat: "wav_16000" | "pcm_16000";
  speechmaticsRtUrl: string;
  speechmaticsLanguage: string;
  speechmaticsEnablePartials: boolean;
  speechmaticsMaxDelaySeconds: number;
  elevenLabsApiKey: string | null;
  elevenLabsVoiceId: string;
  elevenLabsModelId: string;
  apiRateLimitWindowMs: number;
  apiRateLimitMax: number;
  socketUtteranceRateLimitPerMinute: number;
  providerTimeoutMs: number;
  providerMaxRetries: number;
  providerCircuitBreakerFailures: number;
  providerCircuitBreakerCooldownMs: number;
  stripeCheckoutUrl: string | null;
  paidUserEmails: string[];
  telemetryEnabled: boolean;
};

function readString(name: string, fallback = ""): string {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }
  return raw.trim();
}

function readOptional(name: string): string | null {
  const value = readString(name);
  return value.length > 0 ? value : null;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = readString(name);
  if (raw.length === 0) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function readNumber(name: string, fallback: number): number {
  const raw = readString(name);
  if (raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readSpeechmaticsTtsOutputFormat(): "wav_16000" | "pcm_16000" {
  const raw = readString("SPEECHMATICS_TTS_OUTPUT_FORMAT", "wav_16000");
  return raw === "pcm_16000" ? "pcm_16000" : "wav_16000";
}

function readCsvList(name: string): string[] {
  const raw = readString(name);
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function getEnvConfig(): EnvConfig {
  const port = readNumber("PORT", 4000);
  const webOrigin = readString("WEB_ORIGIN", "http://localhost:5173");
  const webOrigins = Array.from(
    new Set([
      webOrigin,
      ...readCsvList("WEB_ORIGINS")
    ])
  );

  return {
    port,
    webOrigin,
    webOrigins,
    supabaseUrl: readOptional("SUPABASE_URL"),
    supabaseAnonKey: readOptional("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: readOptional("SUPABASE_SERVICE_ROLE_KEY"),
    composioApiKey: readOptional("COMPOSIO_API_KEY"),
    composioBaseUrl: readString("COMPOSIO_BASE_URL", "https://backend.composio.dev"),
    composioConnectCallbackUrl: readString(
      "COMPOSIO_CONNECT_CALLBACK_URL",
      `http://localhost:${port}/v1/composio/connect/callback`
    ),
    anthropicApiKey: readOptional("ANTHROPIC_API_KEY"),
    anthropicModel: readString("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
    speechmaticsApiKey: readOptional("SPEECHMATICS_API_KEY"),
    speechmaticsApiBaseUrl: readString("SPEECHMATICS_API_BASE_URL", "https://asr.api.speechmatics.com/v2"),
    speechmaticsTtsBaseUrl: readString("SPEECHMATICS_TTS_BASE_URL", "https://preview.tts.speechmatics.com"),
    speechmaticsTtsVoice: readString("SPEECHMATICS_TTS_VOICE", "sarah"),
    speechmaticsTtsOutputFormat: readSpeechmaticsTtsOutputFormat(),
    speechmaticsRtUrl: readString("SPEECHMATICS_RT_URL", "wss://eu2.rt.speechmatics.com/v2"),
    speechmaticsLanguage: readString("SPEECHMATICS_LANGUAGE", "en"),
    speechmaticsEnablePartials: readBoolean("SPEECHMATICS_ENABLE_PARTIALS", true),
    speechmaticsMaxDelaySeconds: readNumber("SPEECHMATICS_MAX_DELAY_SECONDS", 1.1),
    elevenLabsApiKey: readOptional("ELEVENLABS_API_KEY"),
    elevenLabsVoiceId: readString("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
    elevenLabsModelId: readString("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
    apiRateLimitWindowMs: readNumber("API_RATE_LIMIT_WINDOW_MS", 60_000),
    apiRateLimitMax: readNumber("API_RATE_LIMIT_MAX", 180),
    socketUtteranceRateLimitPerMinute: readNumber("SOCKET_UTTERANCE_RATE_LIMIT_PER_MIN", 45),
    providerTimeoutMs: readNumber("PROVIDER_TIMEOUT_MS", 20_000),
    providerMaxRetries: readNumber("PROVIDER_MAX_RETRIES", 2),
    providerCircuitBreakerFailures: readNumber("PROVIDER_CIRCUIT_BREAKER_FAILURES", 5),
    providerCircuitBreakerCooldownMs: readNumber("PROVIDER_CIRCUIT_BREAKER_COOLDOWN_MS", 30_000),
    stripeCheckoutUrl: readOptional("STRIPE_CHECKOUT_URL"),
    paidUserEmails: readCsvList("PAID_USER_EMAILS").map((value) => value.toLowerCase()),
    telemetryEnabled: readBoolean("TELEMETRY_ENABLED", true)
  };
}

export type { EnvConfig };
