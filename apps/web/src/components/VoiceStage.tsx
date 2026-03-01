import { useEffect, useMemo, useRef, useState } from "react";

import type { ActionDraft, ActionStatusEvent, VoiceState } from "@mark/contracts";

import { useActionNotifications } from "../hooks/useActionNotifications";
import type { CatalogListItem } from "../tabs/AppsTab";
import type { TimelineViewItem } from "../tabs/TimelineTab";
import type { StageMode, TaskNotification } from "../uiTypes";
import type { ActionTimelineItem } from "../useVoiceAgent";
import { ActionNotificationCard } from "./ActionNotificationCard";
import { ActionNotificationLane } from "./ActionNotificationLane";
import { SettingsDrawer, type SettingsDrawerSection } from "./SettingsDrawer";
import type { ProviderDiagnosticItem } from "./types";

const CAPTION_PREVIEW_LIMIT = 132;

type VoiceStageProps = {
  connected: boolean;
  isRunning: boolean;
  isMicMuted: boolean;
  voiceState: VoiceState;
  audioLevel: number;
  sessionId: string | null;
  userPartial: string;
  userFinal: string;
  agentPartial: string;
  agentFinal: string;
  pendingAction: ActionDraft | null;
  actionStatus: ActionStatusEvent | null;
  actionTimeline: ActionTimelineItem[];
  sttMessage: string | null;
  actionStatusMessage: string | null;
  activeTtsProvider: string | null;
  providerDiagnostics: ProviderDiagnosticItem[];
  onStart: () => void;
  onStop: () => void;
  onToggleMic: () => void;
  onResetMemory: () => void;
  onSignOut: () => void;
  onApprovePending: () => void;
  onRejectPending: () => void;
  loadingApps: boolean;
  appsSearch: string;
  onAppsSearchChange: (value: string) => void;
  appsItems: CatalogListItem[];
  connectingAuthConfigId: string | null;
  onConnectApp: (authConfigId: string) => void;
  timelineSourceLabel: string;
  timelineItems: TimelineViewItem[];
};

export function VoiceStage({
  connected,
  isRunning,
  isMicMuted,
  voiceState,
  audioLevel,
  sessionId,
  userPartial,
  userFinal,
  agentPartial,
  agentFinal,
  pendingAction,
  actionStatus,
  actionTimeline,
  sttMessage,
  actionStatusMessage,
  activeTtsProvider,
  providerDiagnostics,
  onStart,
  onStop,
  onToggleMic,
  onResetMemory,
  onSignOut,
  onApprovePending,
  onRejectPending,
  loadingApps,
  appsSearch,
  onAppsSearchChange,
  appsItems,
  connectingAuthConfigId,
  onConnectApp,
  timelineSourceLabel,
  timelineItems
}: VoiceStageProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsDrawerSection>("apps");
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const notifications = useActionNotifications({
    actionTimeline,
    pendingAction,
    actionStatus
  });

  const stageMode = useMemo<StageMode>(() => {
    if (actionStatus?.status === "executing") {
      return "acting";
    }
    switch (voiceState) {
      case "listening":
        return "listening";
      case "thinking":
        return "thinking";
      case "speaking":
        return "speaking";
      default:
        return "idle";
    }
  }, [actionStatus?.status, voiceState]);
  const isListeningMode = isRunning && !isMicMuted && voiceState === "listening";
  const micControlLabel = !isRunning ? "Start listening" : isMicMuted ? "Unmute microphone" : "Mute microphone";
  const micControlClassName = `stitch-mic-btn ${!isRunning ? "is-idle" : isMicMuted ? "is-muted" : "is-live"} ${
    isListeningMode ? "is-listening" : ""
  }`;

  const fullCaption = useMemo(() => {
    const partialUser = userPartial.trim();
    if (partialUser.length > 0) {
      return `You: ${partialUser}`;
    }

    const partialAgent = agentPartial.trim();
    if (partialAgent.length > 0) {
      return `Agent: ${partialAgent}`;
    }

    if (stageMode === "thinking" || stageMode === "acting") {
      return "Agent is working on your request...";
    }

    const finalAgent = agentFinal.trim();
    if (finalAgent.length > 0) {
      return `Agent: ${finalAgent}`;
    }

    const finalUser = userFinal.trim();
    if (finalUser.length > 0) {
      return `You: ${finalUser}`;
    }

    return "Draft a brief follow-up email to the engineering team about the Q4 sprint progress and next steps.";
  }, [agentFinal, agentPartial, stageMode, userFinal, userPartial]);
  const caption = useMemo(() => shorten(fullCaption, CAPTION_PREVIEW_LIMIT), [fullCaption]);
  const canExpandCaption = fullCaption.length > CAPTION_PREVIEW_LIMIT;

  const openSettings = (section: SettingsDrawerSection): void => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const openNotificationCenter = (): void => {
    setNotificationCenterOpen(true);
    setTranscriptModalOpen(false);
    setSettingsOpen(false);
  };

  const closeTranscriptModal = (): void => {
    setTranscriptModalOpen(false);
  };

  const readCaptionAloud = (): void => {
    if (typeof window === "undefined") {
      return;
    }

    const text = fullCaption.trim();
    if (text.length === 0) {
      return;
    }

    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== "function") {
      return;
    }

    synth.cancel();
    synth.speak(new Utterance(text));
  };

  useEffect(() => {
    if (!transcriptModalOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeTranscriptModal();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [transcriptModalOpen]);

  useEffect(
    () => () => {
      if (typeof window !== "undefined") {
        window.speechSynthesis?.cancel();
      }
    },
    []
  );

  return (
    <section className="voice-stage stitch-root stitch-phone-shell" aria-label="Voice stage">
      <div className="stitch-ambient-fluid-border stitch-ambient-fluid-border-strong" aria-hidden />

      {notificationCenterOpen ? (
        <NotificationCenterPage
          notifications={notifications}
          pendingAction={pendingAction}
          onBack={() => setNotificationCenterOpen(false)}
          onApprovePending={onApprovePending}
          onRejectPending={onRejectPending}
        />
      ) : (
        <>
          <header className="voice-stage-nav stitch-header">
            <button
              ref={settingsTriggerRef}
              className="stitch-icon-btn"
              type="button"
              aria-label="Settings"
              onClick={() => openSettings("apps")}
            >
              <span aria-hidden>⚙</span>
            </button>

            <button
              className={micControlClassName}
              type="button"
              aria-label={micControlLabel}
              aria-pressed={isRunning ? isMicMuted : undefined}
              onClick={isRunning ? onToggleMic : onStart}
            >
              <svg className="stitch-mic-icon" viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M12 3.2a2.85 2.85 0 0 0-2.84 2.84v5.24a2.84 2.84 0 0 0 5.68 0V6.04A2.85 2.85 0 0 0 12 3.2z"
                  fill="currentColor"
                />
                <path
                  d="M7.5 10.5a.75.75 0 0 1 .75.75 3.75 3.75 0 0 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.19V19h2.1a.75.75 0 0 1 0 1.5h-5.7a.75.75 0 1 1 0-1.5h2.1v-2.56a5.25 5.25 0 0 1-4.5-5.19.75.75 0 0 1 .75-.75z"
                  fill="currentColor"
                />
                {isMicMuted ? (
                  <path d="M4.6 4.6 19.4 19.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                ) : null}
              </svg>
            </button>
          </header>

          <div className="voice-stage-center stitch-stage-center">
            <p className="stitch-transcript-kicker">Live Transcript</p>
            <p className="stage-caption stitch-stage-caption">{caption}</p>
            <div className="stitch-stage-transcript-actions" role="group" aria-label="Transcript actions">
              {canExpandCaption ? (
                <button
                  type="button"
                  className="stitch-stage-ellipsis-btn"
                  aria-label="View full response"
                  onClick={() => setTranscriptModalOpen(true)}
                >
                  ...
                </button>
              ) : null}
              <button
                type="button"
                className="stitch-stage-read-btn"
                aria-label="Read response aloud"
                onClick={readCaptionAloud}
              >
                <svg className="stitch-stage-read-icon" viewBox="0 0 24 24" aria-hidden>
                  <path
                    d="M12 3.2a2.85 2.85 0 0 0-2.84 2.84v5.24a2.84 2.84 0 0 0 5.68 0V6.04A2.85 2.85 0 0 0 12 3.2z"
                    fill="currentColor"
                  />
                  <path
                    d="M7.5 10.5a.75.75 0 0 1 .75.75 3.75 3.75 0 0 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.19V19h2.1a.75.75 0 0 1 0 1.5h-5.7a.75.75 0 1 1 0-1.5h2.1v-2.56a5.25 5.25 0 0 1-4.5-5.19.75.75 0 0 1 .75-.75z"
                    fill="currentColor"
                  />
                </svg>
                <span>Read aloud</span>
              </button>
            </div>
          </div>

          {transcriptModalOpen ? (
            <div className="stitch-transcript-modal-backdrop" onClick={closeTranscriptModal}>
              <section
                className="stitch-transcript-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="full-response-title"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="stitch-transcript-modal-head">
                  <h2 id="full-response-title">Full response</h2>
                  <button
                    type="button"
                    className="stitch-transcript-modal-close"
                    aria-label="Close full response"
                    onClick={closeTranscriptModal}
                  >
                    Close
                  </button>
                </header>
                <p className="stitch-transcript-modal-text">{fullCaption}</p>
              </section>
            </div>
          ) : null}

          <ActionNotificationLane
            notifications={notifications}
            pendingAction={pendingAction}
            onApprovePending={onApprovePending}
            onRejectPending={onRejectPending}
            onViewAll={openNotificationCenter}
          />
        </>
      )}

      <SettingsDrawer
        open={settingsOpen && !notificationCenterOpen}
        onClose={() => setSettingsOpen(false)}
        returnFocusRef={settingsTriggerRef}
        defaultSection={settingsSection}
        isRunning={isRunning}
        canResetMemory={connected}
        sessionId={sessionId}
        sttMessage={sttMessage}
        actionStatusMessage={actionStatusMessage}
        activeTtsProvider={activeTtsProvider}
        providerDiagnostics={providerDiagnostics}
        onStart={onStart}
        onStop={onStop}
        onResetMemory={onResetMemory}
        onSignOut={onSignOut}
        loadingApps={loadingApps}
        appsSearch={appsSearch}
        onAppsSearchChange={onAppsSearchChange}
        appsItems={appsItems}
        connectingAuthConfigId={connectingAuthConfigId}
        onConnectApp={onConnectApp}
        timelineSourceLabel={timelineSourceLabel}
        timelineItems={timelineItems}
      />
    </section>
  );
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

type NotificationCenterPageProps = {
  notifications: TaskNotification[];
  pendingAction: ActionDraft | null;
  onBack: () => void;
  onApprovePending: () => void;
  onRejectPending: () => void;
};

function NotificationCenterPage({
  notifications,
  pendingAction,
  onBack,
  onApprovePending,
  onRejectPending
}: NotificationCenterPageProps) {
  const hasNotifications = notifications.length > 0;

  return (
    <section className="stitch-notifications-page" aria-label="Notifications center">
      <header className="stitch-notifications-head">
        <button className="stitch-notifications-back" type="button" onClick={onBack} aria-label="Back">
          Back
        </button>
        <h2>Notifications</h2>
        <span className="stitch-notifications-head-spacer" aria-hidden />
      </header>

      {!hasNotifications ? (
        <article className="stitch-notifications-empty" aria-live="polite">
          <p className="stitch-notifications-empty-title">No notifications yet.</p>
          <p className="stitch-notifications-empty-message">When actions happen, they will appear here.</p>
        </article>
      ) : (
        <div className="stitch-notifications-list" aria-label="All notifications">
          {notifications.map((notification) => (
            <ActionNotificationCard
              key={notification.id}
              notification={notification}
              showApprovalControls={shouldShowApprovalControls(notification, pendingAction)}
              onApprovePending={onApprovePending}
              onRejectPending={onRejectPending}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function shouldShowApprovalControls(notification: TaskNotification, pendingAction: ActionDraft | null): boolean {
  return (
    !!pendingAction &&
    notification.actionId === pendingAction.actionId &&
    notification.revisionId === pendingAction.revisionId &&
    notification.tone === "approval"
  );
}
