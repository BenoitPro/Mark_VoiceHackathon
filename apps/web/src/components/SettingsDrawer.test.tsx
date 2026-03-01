import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CatalogListItem } from "../tabs/AppsTab";
import type { TimelineViewItem } from "../tabs/TimelineTab";
import type { ProviderDiagnosticItem } from "./types";
import { SettingsDrawer } from "./SettingsDrawer";

const providerDiagnostics: ProviderDiagnosticItem[] = [
  { label: "STT", value: "ready" },
  { label: "LLM", value: "ready" }
];

const timelineItems: TimelineViewItem[] = [
  {
    id: "timeline-1",
    type: "action.executed",
    message: "Sent follow-up email.",
    createdAt: "2026-03-01T10:00:00.000Z"
  }
];

describe("SettingsDrawer", () => {
  it("renders simplified settings with app connections first", () => {
    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
      />
    );

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "App connections" })).toBeInTheDocument();
    expect(screen.getByLabelText(/search app or toolkit/i)).toBeInTheDocument();
    expect(screen.getByText("Email Platforms")).toBeInTheDocument();
    expect(screen.getByText("Messaging Apps")).toBeInTheDocument();
    expect(screen.getByText("Productivity Tools")).toBeInTheDocument();
    expect(screen.getByText("Other Integrations")).toBeInTheDocument();
    expect(screen.getByText("No apps available in this category.")).toBeInTheDocument();
  });

  it("filters visible apps from search", () => {
    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
        appsSearch="jira"
      />
    );

    expect(screen.getByText("Jira")).toBeInTheDocument();
    expect(screen.queryByText("Gmail")).not.toBeInTheDocument();
  });

  it("shows connected badge and no disconnect action", () => {
    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
      />
    );

    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  });

  it("shows advanced settings inside dropdown", async () => {
    const user = userEvent.setup();

    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
        timelineItems={timelineItems}
      />
    );

    const advancedSettings = screen.getByText("Advanced settings").closest("details");
    expect(advancedSettings).not.toBeNull();
    expect(advancedSettings).not.toHaveAttribute("open");

    await user.click(screen.getByText("Advanced settings"));

    expect(advancedSettings).toHaveAttribute("open");
    expect(screen.getByText("Session Controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Listening" })).toBeInTheDocument();
    expect(screen.getByText("Voice Runtime")).toBeInTheDocument();
    expect(screen.getByText("Catalog & Integrations")).toBeInTheDocument();
    expect(screen.getByText("Transcript Snapshot")).toBeInTheDocument();
    expect(screen.getByText("Runtime Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Sent follow-up email.")).toBeInTheDocument();
  });

  it("focuses close button on open and traps tab navigation inside dialog", async () => {
    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
      />
    );

    const closeButton = screen.getByRole("button", { name: "Close" });
    await waitFor(() => {
      expect(closeButton).toHaveFocus();
    });

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const signOutButton = screen.getByRole("button", { name: "Sign Out" });

    signOutButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(signOutButton).toHaveFocus();
  });

  it("restores focus to trigger after close", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
        onClose={onClose}
        returnFocusRef={{ current: trigger }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });

    trigger.remove();
  });

  it("connects an inactive app and shows connecting state", async () => {
    const user = userEvent.setup();
    const onConnectApp = vi.fn();
    const items = sampleApps();
    const outlook = items.find((item) => item.toolkitName === "Outlook")!;

    const { rerender } = render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={items}
        onConnectApp={onConnectApp}
      />
    );

    await user.click(screen.getByRole("button", { name: "Connect Outlook" }));
    expect(onConnectApp).toHaveBeenCalledWith(outlook.authConfigId);

    rerender(
      <SettingsDrawer
        {...baseProps()}
        appsItems={items}
        connectingAuthConfigId={outlook.authConfigId}
        onConnectApp={onConnectApp}
      />
    );

    expect(screen.getByRole("button", { name: "Connecting Outlook" })).toBeDisabled();
  });

  it("closes with backdrop click and Escape key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
        onClose={onClose}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close settings panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps sign out available in footer", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();

    render(
      <SettingsDrawer
        {...baseProps()}
        appsItems={sampleApps()}
        onSignOut={onSignOut}
      />
    );

    await user.click(screen.getByRole("button", { name: "Sign Out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

function sampleApps(): CatalogListItem[] {
  return [
    {
      authConfigId: "cfg-gmail",
      toolkitName: "Gmail",
      name: "Gmail",
      authScheme: "oauth2",
      statusLabel: "active",
      isActive: true,
      toolkitSlug: "gmail"
    } as CatalogListItem,
    {
      authConfigId: "cfg-outlook",
      toolkitName: "Outlook",
      name: "Outlook",
      authScheme: "oauth2",
      statusLabel: "not connected",
      isActive: false,
      toolkitSlug: "outlook"
    } as CatalogListItem,
    {
      authConfigId: "cfg-slack",
      toolkitName: "Slack",
      name: "Slack",
      authScheme: "oauth2",
      statusLabel: "active",
      isActive: true,
      toolkitSlug: "slack"
    } as CatalogListItem,
    {
      authConfigId: "cfg-jira",
      toolkitName: "Jira",
      name: "Jira",
      authScheme: "oauth2",
      statusLabel: "not connected",
      isActive: false,
      toolkitSlug: "jira"
    } as CatalogListItem
  ];
}

function baseProps() {
  return {
    open: true,
    onClose: vi.fn(),
    returnFocusRef: null,
    defaultSection: "apps" as const,
    isRunning: false,
    canResetMemory: true,
    sessionId: "session-1",
    sttMessage: null,
    actionStatusMessage: null,
    activeTtsProvider: null,
    connected: true,
    isMicMuted: false,
    voiceState: "idle",
    audioLevel: 0.2,
    userPartial: "",
    userFinal: "",
    agentPartial: "",
    agentFinal: "",
    providerDiagnostics,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onResetMemory: vi.fn(),
    onSignOut: vi.fn(),
    loadingApps: false,
    appsSearch: "",
    onAppsSearchChange: vi.fn(),
    appsItems: [],
    connectingAuthConfigId: null,
    onConnectApp: vi.fn(),
    timelineSourceLabel: "Live session events",
    timelineItems: []
  };
}
