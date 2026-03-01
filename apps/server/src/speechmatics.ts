import type { EnvConfig } from "./env.js";
import { CircuitBreaker, isRetriableError, withRetries, withTimeout } from "./reliability.js";

export class SpeechmaticsAdapter {
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

  async transcribeUtterance(audioBase64: string, mimeType: string): Promise<string> {
    if (!this.env.speechmaticsApiKey) {
      throw new Error("SPEECHMATICS_API_KEY missing");
    }

    const bytes = Buffer.from(audioBase64, "base64");
    if (bytes.length === 0) {
      throw new Error("Empty utterance payload");
    }

    const uploadUrl = `${this.env.speechmaticsApiBaseUrl}/jobs/?type=transcription`;
    const formData = new FormData();
    formData.append(
      "config",
      JSON.stringify({
        type: "transcription",
        transcription_config: {
          language: this.env.speechmaticsLanguage
        }
      })
    );

    formData.append("data_file", new Blob([bytes], { type: mimeType }), pickFileName(mimeType));

    const createRes = await this.runRequest((signal) =>
      fetch(uploadUrl, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${this.env.speechmaticsApiKey}`
        },
        body: formData
      })
    );

    if (!createRes.ok) {
      this.recordProviderError();
      const body = await safeText(createRes);
      throw new Error(`Speechmatics create job failed (${createRes.status}): ${body}`);
    }

    const created = (await createRes.json()) as { id?: string };
    const jobId = typeof created.id === "string" ? created.id : "";
    if (!jobId) {
      this.recordProviderError();
      throw new Error("Speechmatics did not return a job id");
    }

    await this.waitForJobCompletion(jobId);

    const transcriptRes = await this.runRequest((signal) =>
      fetch(`${this.env.speechmaticsApiBaseUrl}/jobs/${jobId}/transcript?format=txt`, {
        method: "GET",
        signal,
        headers: {
          Authorization: `Bearer ${this.env.speechmaticsApiKey}`
        }
      })
    );

    if (!transcriptRes.ok) {
      this.recordProviderError();
      const body = await safeText(transcriptRes);
      throw new Error(`Speechmatics transcript failed (${transcriptRes.status}): ${body}`);
    }

    const transcript = (await transcriptRes.text()).trim();
    return transcript;
  }

  private async waitForJobCompletion(jobId: string): Promise<void> {
    const maxAttempts = 180;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await this.runRequest(
        (signal) =>
          fetch(`${this.env.speechmaticsApiBaseUrl}/jobs/${jobId}`, {
            method: "GET",
            signal,
            headers: {
              Authorization: `Bearer ${this.env.speechmaticsApiKey}`
            }
          }),
        { retries: 0 }
      );

      if (!res.ok) {
        this.recordProviderError();
        const body = await safeText(res);
        throw new Error(`Speechmatics polling failed (${res.status}): ${body}`);
      }

      const data = (await res.json()) as { status?: string; job?: { status?: string } };
      const status = String(data.status ?? data.job?.status ?? "").toLowerCase();

      if (status === "done") {
        return;
      }

      if (["rejected", "failed", "error", "expired"].includes(status)) {
        this.recordProviderError();
        throw new Error(`Speechmatics job ${jobId} ended with status: ${status}`);
      }

      await sleep(1000);
    }

    this.recordProviderError();
    throw new Error(`Speechmatics job ${jobId} timed out`);
  }

  private recordProviderError(): void {
    this.lastProviderErrorAt = new Date().toISOString();
  }

  private async runRequest(
    request: (signal: AbortSignal) => Promise<Response>,
    options?: { retries?: number }
  ): Promise<Response> {
    try {
      return await this.breaker.execute(() =>
        withRetries(
          () =>
            withTimeout(
              (signal) => request(signal),
              this.env.providerTimeoutMs,
              "Speechmatics request timed out."
            ),
          {
            retries: options?.retries ?? this.env.providerMaxRetries,
            shouldRetry: isRetriableError
          }
        )
      );
    } catch (error) {
      this.recordProviderError();
      throw error;
    }
  }
}

function pickFileName(mimeType: string): string {
  if (mimeType === "audio/mpeg") {
    return "utterance.mp3";
  }
  return "utterance.audio";
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
