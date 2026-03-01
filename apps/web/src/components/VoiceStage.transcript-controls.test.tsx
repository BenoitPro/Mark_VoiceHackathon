import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ActionStatusEvent } from "@mark/contracts";

import type { ProviderDiagnosticItem } from "./types";
import { VoiceStage } from "./VoiceStage";

const diagnostics: ProviderDiagnosticItem[] = [
  { label: "STT", value: "ready" },
  { label: "LLM", value: "ready" }
];

const LONG_AGENT_REPLY =
  "Perfect! Here's a summary of your last 10 messages across both platforms: ## **Gmail - Last 10 Sent Emails:** 1. **Feb 20, 2026** - \"Pass marathon running\" - Forwarded and archived with follow-up notes for the marketing team before the sprint planning session tomorrow morning.";

describe("VoiceStage transcript controls", () => {
  it("shows an overflow button when the transcript preview is truncated", () => {
    render(
      <VoiceStage
        {...createBaseProps()}
        agentFinal={LONG_AGENT_REPLY}
      />
    );

    expect(screen.getByRole("button", { name: "View full response" })).toBeInTheDocument();
  });

  it("opens a modal with the full textual response", async () => {
    const user = userEvent.setup();

    render(
      <VoiceStage
        {...createBaseProps()}
        agentFinal={LONG_AGENT_REPLY}
      />
    );

    await user.click(screen.getByRole("button", { name: "View full response" }));

    const dialog = screen.getByRole("dialog", { name: "Full response" });
    expect(dialog).toHaveTextContent(`Agent: ${LONG_AGENT_REPLY}`);
  });

  it("reads the complete transcript aloud when the microphone button is pressed", async () => {
    const user = userEvent.setup();
    const speak = vi.fn();
    const cancel = vi.fn();

    class MockSpeechSynthesisUtterance {
      text: string;

      constructor(text: string) {
        this.text = text;
      }
    }

    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak,
        cancel
      }
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: MockSpeechSynthesisUtterance
    });

    render(
      <VoiceStage
        {...createBaseProps()}
        agentFinal={LONG_AGENT_REPLY}
      />
    );

    await user.click(screen.getByRole("button", { name: "Read response aloud" }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as { text: string }).text).toBe(`Agent: ${LONG_AGENT_REPLY}`);
  });
});

function createBaseProps(): ComponentProps<typeof VoiceStage> {
  return {
    connected: true,
    isRunning: false,
    isMicMuted: false,
    voiceState: "idle",
    audioLevel: 0,
    sessionId: "session-1",
    userPartial: "",
    userFinal: "",
    agentPartial: "",
    agentFinal: "",
    pendingAction: null,
    actionStatus: null as ActionStatusEvent | null,
    actionTimeline: [],
    sttMessage: null,
    actionStatusMessage: null,
    activeTtsProvider: null,
    providerDiagnostics: diagnostics,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onToggleMic: vi.fn(),
    onResetMemory: vi.fn(),
    onSignOut: vi.fn(),
    onApprovePending: vi.fn(),
    onRejectPending: vi.fn(),
    loadingApps: false,
    appsSearch: "",
    onAppsSearchChange: vi.fn(),
    appsItems: [],
    connectingAuthConfigId: null,
    onConnectApp: vi.fn(),
    timelineSourceLabel: "No events",
    timelineItems: []
  };
}
