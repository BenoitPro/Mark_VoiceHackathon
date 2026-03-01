import type { EnvConfig } from "./env.js";

export class ElevenLabsService {
  private readonly baseUrl = "https://api.elevenlabs.io/v1";
  private lastProviderErrorAt: string | null = null;

  constructor(private readonly env: EnvConfig) {}

  isConfigured(): boolean {
    return Boolean(this.env.elevenLabsApiKey);
  }

  getLastProviderErrorAt(): string | null {
    return this.lastProviderErrorAt;
  }

  async synthesizeStream(
    text: string,
    onChunk: (chunk: Buffer, streamId: string) => void
  ): Promise<string> {
    const streamId = `tts-${Date.now()}`;

    if (!this.env.elevenLabsApiKey) {
      this.lastProviderErrorAt = new Date().toISOString();
      throw new Error("ELEVENLABS_API_KEY missing for TTS fallback.");
    }

    const response = await fetch(`${this.baseUrl}/text-to-speech/${this.env.elevenLabsVoiceId}/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "audio/mpeg",
        "xi-api-key": this.env.elevenLabsApiKey
      },
      body: JSON.stringify({
        text,
        model_id: this.env.elevenLabsModelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true
        },
        output_format: "mp3_44100_128"
      })
    });

    if (!response.ok || !response.body) {
      this.lastProviderErrorAt = new Date().toISOString();
      const details = await safeText(response);
      throw new Error(`ElevenLabs error ${response.status}: ${details}`);
    }

    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      onChunk(Buffer.from(value), streamId);
    }

    return streamId;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
