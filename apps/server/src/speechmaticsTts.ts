import type { EnvConfig } from "./env.js";
import { CircuitBreaker, isRetriableError, withRetries, withTimeout } from "./reliability.js";

export class SpeechmaticsTtsService {
  private lastProviderErrorAt: string | null = null;
  private readonly breaker: CircuitBreaker;

  constructor(private readonly env: EnvConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: env.providerCircuitBreakerFailures,
      cooldownMs: env.providerCircuitBreakerCooldownMs
    });
  }

  isConfigured(): boolean {
    return Boolean(this.env.speechmaticsApiKey);
  }

  getLastProviderErrorAt(): string | null {
    return this.lastProviderErrorAt;
  }

  async synthesizeStream(
    text: string,
    onChunk: (chunk: Buffer, streamId: string) => void,
    signal?: AbortSignal
  ): Promise<{ streamId: string; contentType: "audio/wav" }> {
    const streamId = `tts-sm-${Date.now()}`;

    if (!this.env.speechmaticsApiKey) {
      throw new Error("SPEECHMATICS_API_KEY missing for TTS");
    }

    if (this.env.speechmaticsTtsOutputFormat !== "wav_16000") {
      throw new Error(
        `Speechmatics TTS output format ${this.env.speechmaticsTtsOutputFormat} is unsupported by current player.`
      );
    }

    const url = `${this.env.speechmaticsTtsBaseUrl}/generate/${encodeURIComponent(this.env.speechmaticsTtsVoice)}?output_format=${this.env.speechmaticsTtsOutputFormat}`;
    const response = await this.breaker.execute(() =>
      withRetries(
        () =>
          withTimeout(
            (timeoutSignal) => {
              const combinedSignal = mergeAbortSignals(timeoutSignal, signal);
              return fetch(url, {
                method: "POST",
                signal: combinedSignal,
                headers: {
                  Authorization: `Bearer ${this.env.speechmaticsApiKey}`,
                  "content-type": "application/json"
                },
                body: JSON.stringify({
                  text
                })
              });
            },
            this.env.providerTimeoutMs,
            "Speechmatics TTS request timed out."
          ),
        {
          retries: this.env.providerMaxRetries,
          shouldRetry: isRetriableError
        }
      )
    );

    if (!response.ok || !response.body) {
      this.lastProviderErrorAt = new Date().toISOString();
      const details = await safeText(response);
      throw new Error(`Speechmatics TTS error ${response.status}: ${details}`);
    }

    const reader = response.body.getReader();
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Speechmatics TTS aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      onChunk(Buffer.from(value), streamId);
    }

    return {
      streamId,
      contentType: "audio/wav"
    };
  }
}

function mergeAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) {
    return primary;
  }
  if (secondary.aborted) {
    return secondary;
  }
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
  };
  primary.addEventListener("abort", onAbort, { once: true });
  secondary.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
