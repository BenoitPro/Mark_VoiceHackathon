import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ActionDraft, ActionStatusEvent } from "@mark/contracts";

import type { ProviderDiagnosticItem } from "./types";
import { VoiceStage } from "./VoiceStage";

const diagnostics: ProviderDiagnosticItem[] = [
  { label: "STT", value: "ready" },
  { label: "LLM", value: "ready" }
];

const pendingAction: ActionDraft = {
  actionId: "action-1",
  revisionId: "revision-1",
  status: "pending_approval",
  toolSlug: "gmail_send_email",
  toolkitSlug: "gmail",
  connectedAccountId: "acct-1",
  summary: "Send this email draft to product@company.com",
  arguments: {
    to: "product@company.com"
  },
  requiresApproval: true,
  createdAt: "2026-03-01T08:00:00.000Z",
  updatedAt: "2026-03-01T08:00:00.000Z"
};

describe("VoiceStage", () => {
  it("starts listening when microphone control is pressed while idle", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();

    render(
      <VoiceStage
        {...createBaseProps()}
        isRunning={false}
        onStart={onStart}
      />
    );

    const control = screen.getByRole("button", { name: "Start listening" });
    expect(control).not.toHaveTextContent("Start listening");
    await user.click(control);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("blocks start action when a start blocker is present", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();

    render(
      <VoiceStage
        {...createBaseProps()}
        startBlockedReason="Connect Gmail first."
        onStart={onStart}
      />
    );

    const control = screen.getByRole("button", { name: "Connect Gmail to start listening" });
    expect(control).toBeDisabled();
    expect(screen.getByText("Connect Gmail first.")).toBeInTheDocument();
    await user.click(control);
    expect(onStart).toHaveBeenCalledTimes(0);
  });

  it("toggles microphone mute when control is pressed while running", async () => {
    const user = userEvent.setup();
    const onToggleMic = vi.fn();

    render(
      <VoiceStage
        {...createBaseProps()}
        isRunning
        voiceState="listening"
        onToggleMic={onToggleMic}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(onToggleMic).toHaveBeenCalledTimes(1);
  });

  it("renders muted state when microphone is muted", () => {
    render(
      <VoiceStage
        {...createBaseProps()}
        isRunning
        isMicMuted
      />
    );

    const control = screen.getByRole("button", { name: "Unmute microphone" });
    expect(control.className).toContain("is-muted");
    expect(control).toHaveAttribute("aria-pressed", "true");
  });

  it("renders live state when microphone is active", () => {
    render(
      <VoiceStage
        {...createBaseProps()}
        isRunning
        isMicMuted={false}
      />
    );

    const control = screen.getByRole("button", { name: "Mute microphone" });
    expect(control.className).toContain("is-live");
    expect(control).toHaveAttribute("aria-pressed", "false");
  });

  it("opens and closes settings drawer", async () => {
    const user = userEvent.setup();

    render(<VoiceStage {...createBaseProps()} />);
    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const advancedSettings = screen.getByText("Advanced settings").closest("details");
    expect(advancedSettings).not.toBeNull();
    expect(advancedSettings).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("renders approval actions for pending notifications and handles clicks", async () => {
    const user = userEvent.setup();
    const onApprovePending = vi.fn();
    const onRejectPending = vi.fn();

    render(
      <VoiceStage
        {...createBaseProps()}
        pendingAction={pendingAction}
        actionTimeline={[
          {
            id: "event-1",
            actionId: pendingAction.actionId,
            revisionId: pendingAction.revisionId,
            type: "action.proposed",
            message: "Draft ready for your approval.",
            createdAt: "2026-03-01T08:00:00.000Z"
          }
        ]}
        onApprovePending={onApprovePending}
        onRejectPending={onRejectPending}
      />
    );

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(screen.getByRole("heading", { name: "Recent Activity" })).toBeInTheDocument();
    expect(onApprovePending).toHaveBeenCalledTimes(1);
    expect(onRejectPending).toHaveBeenCalledTimes(1);
  });

  it("does not render the legacy voice core orb", () => {
    render(<VoiceStage {...createBaseProps()} />);

    expect(screen.queryByRole("img", { name: /Voice state:/i })).not.toBeInTheDocument();
  });

  it("uses a realistic transcript fallback when no live transcript is available", () => {
    render(<VoiceStage {...createBaseProps()} />);

    expect(screen.getByRole("heading", { name: "Recent Activity" })).toBeInTheDocument();
    expect(screen.getByText(/Ready\. Ask me to triage your unread inbox emails\./i)).toBeInTheDocument();
  });

  it("shows an empty activity lane when there are no live notifications", () => {
    render(<VoiceStage {...createBaseProps()} />);

    expect(screen.queryByText("Slack from your manager")).not.toBeInTheDocument();
    expect(screen.queryByText("LinkedIn client message")).not.toBeInTheDocument();
    expect(screen.queryByText("Big deal email")).not.toBeInTheDocument();
    expect(screen.getByText("No recent actions yet.")).toBeInTheDocument();
    expect(screen.getByText("Speak to generate your first activity item.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();
  });

  it("opens the notifications page when View all is pressed", async () => {
    const user = userEvent.setup();

    render(
      <VoiceStage
        {...createBaseProps()}
        actionTimeline={[
          {
            id: "timeline-1",
            actionId: "action-1",
            revisionId: "revision-1",
            type: "action.executed",
            message: "Sent follow-up email.",
            createdAt: "2026-03-01T10:00:00.000Z"
          }
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "View all" }));

    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(await screen.findByText("Sent follow-up email.")).toBeInTheDocument();
  });

  it("shows an empty notifications page when View all is pressed with no notifications", async () => {
    const user = userEvent.setup();

    render(<VoiceStage {...createBaseProps()} />);

    await user.click(screen.getByRole("button", { name: "View all" }));

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByText("No notifications yet.")).toBeInTheDocument();
    expect(screen.getByText(/When actions happen, they will appear here./i)).toBeInTheDocument();
  });

  it("restores focus to the Settings trigger after closing the drawer", async () => {
    const user = userEvent.setup();

    render(<VoiceStage {...createBaseProps()} />);
    const settingsButton = screen.getByRole("button", { name: "Settings" });
    await user.click(settingsButton);
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(settingsButton).toHaveFocus();
    });
  });

  it("prioritizes partial transcript in the stage caption", () => {
    render(
      <VoiceStage
        {...createBaseProps()}
        userFinal="Past user sentence"
        agentFinal="Past agent sentence"
        agentPartial="Streaming now"
      />
    );

    expect(screen.getByText(/Agent: Streaming now/i)).toBeInTheDocument();
  });
});

function createBaseProps(): ComponentProps<typeof VoiceStage> {
  return {
    connected: true,
    isRunning: false,
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
    startBlockedReason: null,
    onStart: vi.fn(),
    onStop: vi.fn(),
    isMicMuted: false,
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
