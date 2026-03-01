import type { EnvConfig } from "./env.js";

export class SpeechmaticsTtsService {
  private lastProviderErrorAt: string | null = null;

  constructor(private readonly env: EnvConfig) {}

  isConfigured(): boolean {
    return Boolean(this.env.speechmaticsApiKey);
  }

  getLastProviderErrorAt(): string | null {
    return this.lastProviderErrorAt;
  }

  async synthesizeStream(
    text: string,
    onChunk: (chunk: Buffer, streamId: string) => void
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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.speechmaticsApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text
      })
    });

    if (!response.ok || !response.body) {
      this.lastProviderErrorAt = new Date().toISOString();
      const details = await safeText(response);
      throw new Error(`Speechmatics TTS error ${response.status}: ${details}`);
    }

    const reader = response.body.getReader();
    while (true) {
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

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
