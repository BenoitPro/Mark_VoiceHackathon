import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ioMock = vi.fn();
const micStartMock = vi.fn();
const micStopMock = vi.fn();

vi.mock("socket.io-client", () => {
  return {
    io: (...args: unknown[]) => ioMock(...args)
  };
});

vi.mock("./audio", () => {
  class MockMicrophonePipeline {
    constructor(_onChunk: (event: { pcm16: Int16Array; rms: number }) => void) {}
    start(): Promise<void> {
      return micStartMock();
    }
    stop(): Promise<void> {
      return micStopMock();
    }
  }

  return {
    MicrophonePipeline: MockMicrophonePipeline
  };
});

import { useVoiceAgent } from "./useVoiceAgent";

function createSocketStub() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    connected: false,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(handler);
      listeners.set(event, current);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(() => listeners.clear())
  };
}

describe("useVoiceAgent startup behavior", () => {
  beforeEach(() => {
    ioMock.mockReset();
    micStartMock.mockReset();
    micStopMock.mockReset();
    micStartMock.mockResolvedValue(undefined);
    micStopMock.mockResolvedValue(undefined);
    ioMock.mockReturnValue(createSocketStub());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          sttConfigured: true,
          ttsConfigured: true,
          llmConfigured: true,
          authConfigured: true,
          composioConfigured: true,
          lastSttErrorAt: null,
          lastTtsErrorAt: null
        })
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not auto-start the voice session when token appears", async () => {
    const audioElement = document.createElement("audio");
    const { rerender } = renderHook(({ token }) => useVoiceAgent(audioElement, token), {
      initialProps: { token: null as string | null }
    });

    rerender({ token: "access-token" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(ioMock).not.toHaveBeenCalled();
    expect(micStartMock).not.toHaveBeenCalled();
  });
});
