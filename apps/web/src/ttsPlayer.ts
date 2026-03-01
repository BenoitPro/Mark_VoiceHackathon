export class StreamingTtsPlayer {
  private audio: HTMLAudioElement;
  private onPlaybackChange: (isPlaying: boolean) => void;
  private activeStreamId: string | null = null;
  private activeContentType: "audio/mpeg" | "audio/wav" | null = null;
  private usingMediaSource = false;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private appendQueue: Uint8Array[] = [];
  private fallbackChunks: Uint8Array[] = [];
  private endRequested = false;

  constructor(audio: HTMLAudioElement, onPlaybackChange: (isPlaying: boolean) => void) {
    this.audio = audio;
    this.onPlaybackChange = onPlaybackChange;

    this.audio.addEventListener("ended", this.handleEnded);
    this.audio.addEventListener("pause", this.handlePause);
  }

  enqueueChunk(streamId: string, chunkBase64: string, contentType: "audio/mpeg" | "audio/wav"): void {
    this.ensureStream(streamId, contentType);
    const bytes = base64ToBytes(chunkBase64);
    this.fallbackChunks.push(bytes);

    if (!this.usingMediaSource) {
      return;
    }

    this.appendQueue.push(bytes);
    this.flushAppendQueue();
  }

  endStream(streamId: string): void {
    if (this.activeStreamId !== streamId) {
      return;
    }

    this.endRequested = true;

    if (!this.usingMediaSource) {
      void this.playFallbackBlob();
      return;
    }

    this.flushAppendQueue();
    this.tryFinishMediaSource();
  }

  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.cleanupStream();
    this.onPlaybackChange(false);
  }

  dispose(): void {
    this.stop();
    this.audio.removeEventListener("ended", this.handleEnded);
    this.audio.removeEventListener("pause", this.handlePause);
  }

  private ensureStream(streamId: string, contentType: "audio/mpeg" | "audio/wav"): void {
    if (this.activeStreamId === streamId) {
      return;
    }

    this.cleanupStream();
    this.activeStreamId = streamId;
    this.activeContentType = contentType;
    this.endRequested = false;

    this.usingMediaSource =
      contentType === "audio/mpeg" &&
      typeof MediaSource !== "undefined" &&
      MediaSource.isTypeSupported("audio/mpeg");

    if (!this.usingMediaSource) {
      return;
    }

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.audio.src = this.objectUrl;

    this.mediaSource.addEventListener("sourceopen", () => {
      if (!this.mediaSource || this.mediaSource.readyState !== "open") {
        return;
      }

      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer("audio/mpeg");
        this.sourceBuffer.mode = "sequence";
        this.sourceBuffer.addEventListener("updateend", () => {
          this.flushAppendQueue();
          this.tryFinishMediaSource();
        });
        this.flushAppendQueue();
      } catch {
        this.usingMediaSource = false;
      }
    });

    void this.audio.play().then(() => {
      this.onPlaybackChange(true);
    }).catch(() => {
      // Browser can reject autoplay before first user gesture.
    });
  }

  private flushAppendQueue(): void {
    if (!this.usingMediaSource || !this.sourceBuffer || this.sourceBuffer.updating) {
      return;
    }

    const next = this.appendQueue.shift();
    if (!next) {
      return;
    }

    try {
      const buffer = copyToArrayBuffer(next);
      this.sourceBuffer.appendBuffer(buffer);
    } catch {
      this.usingMediaSource = false;
    }
  }

  private tryFinishMediaSource(): void {
    if (!this.usingMediaSource || !this.endRequested || !this.mediaSource) {
      return;
    }

    if (this.appendQueue.length > 0) {
      return;
    }

    if (this.sourceBuffer?.updating) {
      return;
    }

    if (this.mediaSource.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch {
        this.usingMediaSource = false;
      }
    }
  }

  private async playFallbackBlob(): Promise<void> {
    if (this.fallbackChunks.length === 0) {
      this.onPlaybackChange(false);
      return;
    }

    const blobParts = this.fallbackChunks.map((chunk) => copyToArrayBuffer(chunk));
    const blob = new Blob(blobParts, { type: this.activeContentType ?? "audio/mpeg" });
    const url = URL.createObjectURL(blob);

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }

    this.objectUrl = url;
    this.audio.src = url;

    try {
      await this.audio.play();
      this.onPlaybackChange(true);
    } catch {
      this.onPlaybackChange(false);
    }
  }

  private handleEnded = (): void => {
    this.onPlaybackChange(false);
    this.cleanupStream();
  };

  private handlePause = (): void => {
    if (this.audio.ended) {
      return;
    }

    // Some browsers trigger pause between source updates; do not force idle here.
  };

  private cleanupStream(): void {
    this.activeStreamId = null;
    this.activeContentType = null;
    this.endRequested = false;
    this.appendQueue = [];
    this.fallbackChunks = [];
    this.sourceBuffer = null;

    if (this.mediaSource) {
      this.mediaSource = null;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
