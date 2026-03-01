import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";

import type { CatalogListItem } from "../tabs/AppsTab";
import type { TimelineViewItem } from "../tabs/TimelineTab";
import { categorizeAppSlug, STITCH_CATEGORY_LABELS, STITCH_CATEGORY_ORDER, type StitchAppCategoryId } from "./stitch/stitch-app-categories";
import { StitchAppLogo } from "./stitch/stitch-app-logo";
import type { ProviderDiagnosticItem } from "./types";

export type SettingsDrawerSection = "session" | "apps" | "timeline";

type SettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null> | null;
  defaultSection?: SettingsDrawerSection;
  connected: boolean;
  isRunning: boolean;
  isMicMuted: boolean;
  voiceState: string;
  audioLevel: number;
  userPartial: string;
  userFinal: string;
  agentPartial: string;
  agentFinal: string;
  canResetMemory: boolean;
  sessionId: string | null;
  sttMessage: string | null;
  actionStatusMessage: string | null;
  activeTtsProvider: string | null;
  providerDiagnostics: ProviderDiagnosticItem[];
  onStart: () => void;
  onStop: () => void;
  onResetMemory: () => void;
  onSignOut: () => void;
  loadingApps: boolean;
  appsSearch: string;
  onAppsSearchChange: (value: string) => void;
  appsItems: CatalogListItem[];
  connectingAuthConfigId: string | null;
  onConnectApp: (authConfigId: string) => void;
  timelineSourceLabel: string;
  timelineItems: TimelineViewItem[];
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled]):not([tabindex='-1'])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(", ");

export function SettingsDrawer({
  open,
  onClose,
  returnFocusRef = null,
  defaultSection = "apps",
  connected,
  isRunning,
  isMicMuted,
  voiceState,
  audioLevel,
  userPartial,
  userFinal,
  agentPartial,
  agentFinal,
  canResetMemory,
  sessionId,
  sttMessage,
  actionStatusMessage,
  activeTtsProvider,
  providerDiagnostics,
  onStart,
  onStop,
  onResetMemory,
  onSignOut,
  loadingApps,
  appsSearch,
  onAppsSearchChange,
  appsItems,
  connectingAuthConfigId,
  onConnectApp,
  timelineSourceLabel,
  timelineItems
}: SettingsDrawerProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const filteredItems = useMemo(() => {
    const needle = appsSearch.trim().toLowerCase();
    if (!needle) {
      return appsItems;
    }

    return appsItems.filter((item) => {
      const terms = [item.toolkitName, item.name, item.toolkitSlug, item.authScheme ?? "", item.statusLabel];
      return terms.some((term) => term.toLowerCase().includes(needle));
    });
  }, [appsItems, appsSearch]);

  const groupedItems = useMemo(() => {
    const groups: Record<StitchAppCategoryId, CatalogListItem[]> = {
      email: [],
      messaging: [],
      productivity: [],
      other: []
    };

    for (const item of filteredItems) {
      groups[categorizeAppSlug(item.toolkitSlug)].push(item);
    }

    for (const categoryId of STITCH_CATEGORY_ORDER) {
      groups[categoryId].sort((left, right) => {
        if (left.isActive !== right.isActive) {
          return left.isActive ? -1 : 1;
        }
        return left.toolkitName.localeCompare(right.toolkitName);
      });
    }

    return groups;
  }, [filteredItems]);

  const categoryStats = useMemo(() => {
    const stats: Record<StitchAppCategoryId, { total: number; connected: number }> = {
      email: { total: 0, connected: 0 },
      messaging: { total: 0, connected: 0 },
      productivity: { total: 0, connected: 0 },
      other: { total: 0, connected: 0 }
    };

    for (const categoryId of STITCH_CATEGORY_ORDER) {
      const items = groupedItems[categoryId];
      stats[categoryId] = {
        total: items.length,
        connected: items.filter((item) => item.isActive).length
      };
    }

    return stats;
  }, [groupedItems]);

  const appSummary = useMemo(() => {
    const total = appsItems.length;
    const connectedCount = appsItems.filter((item) => item.isActive).length;
    const visibleCount = filteredItems.length;
    const pendingName = appsItems.find((item) => item.authConfigId === connectingAuthConfigId)?.toolkitName ?? "none";
    return {
      total,
      connected: connectedCount,
      notConnected: Math.max(0, total - connectedCount),
      visible: visibleCount,
      hidden: Math.max(0, total - visibleCount),
      pendingName
    };
  }, [appsItems, connectingAuthConfigId, filteredItems.length]);

  const voiceRuntime = useMemo(() => {
    return {
      connection: connected ? "connected" : "disconnected",
      listening: isRunning ? "running" : "stopped",
      microphone: !isRunning ? "idle" : isMicMuted ? "muted" : "live",
      stage: voiceState,
      audioInput: formatAudioLevel(audioLevel)
    };
  }, [audioLevel, connected, isMicMuted, isRunning, voiceState]);

  const transcriptSnapshot = useMemo(() => {
    return {
      userPartial: previewSettingValue(userPartial, "none"),
      userFinal: previewSettingValue(userFinal, "none"),
      agentPartial: previewSettingValue(agentPartial, "none"),
      agentFinal: previewSettingValue(agentFinal, "none")
    };
  }, [agentFinal, agentPartial, userFinal, userPartial]);

  const timelinePreview = useMemo(() => {
    return timelineItems.slice(0, 6);
  }, [timelineItems]);

  if (!open) {
    return null;
  }

  const handleClose = (): void => {
    onClose();
    window.requestAnimationFrame(() => {
      returnFocusRef?.current?.focus();
    });
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
      return;
    }

    if (event.key !== "Tab" || !dialogRef.current) {
      return;
    }

    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => !element.hasAttribute("disabled")
    );

    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button className="stitch-settings-backdrop" onClick={handleClose} aria-label="Close settings panel" tabIndex={-1} />
      <aside
        ref={dialogRef}
        className="stitch-settings-drawer stitch-root"
        role="dialog"
        aria-modal="true"
        aria-label="Voice settings and controls"
        aria-labelledby="settings-drawer-title"
        onKeyDown={handleDialogKeyDown}
      >
        <div className="stitch-settings-shell">
          <header className="stitch-settings-header">
            <h2 id="settings-drawer-title">Settings</h2>
            <button ref={closeButtonRef} className="stitch-mini-btn is-neutral" type="button" onClick={handleClose}>
              Close
            </button>
          </header>

          <div className="stitch-settings-scroll">
            <section className="stitch-settings-panel" aria-label="App connections">
              <h3>App connections</h3>

              <div className="stitch-settings-search">
                <label htmlFor="settings-app-search">Search app or toolkit</label>
                <input
                  id="settings-app-search"
                  className="stitch-settings-input"
                  placeholder="Search app or toolkit"
                  value={appsSearch}
                  onChange={(event) => onAppsSearchChange(event.target.value)}
                />
              </div>

              {loadingApps ? <p className="stitch-settings-hint">Loading integrations...</p> : null}
              {!loadingApps && filteredItems.length === 0 ? <p className="stitch-settings-hint">No matching apps.</p> : null}

              {STITCH_CATEGORY_ORDER.map((categoryId, index) => (
                <details key={categoryId} className="stitch-accordion" open={index === 0}>
                  <summary>
                    <span>{STITCH_CATEGORY_LABELS[categoryId]}</span>
                    <span className="stitch-accordion-count">
                      {categoryStats[categoryId].connected}/{categoryStats[categoryId].total} connected
                    </span>
                  </summary>

                  <div className="stitch-accordion-content">
                    {groupedItems[categoryId].length === 0 ? (
                      <p className="stitch-settings-hint">No apps available in this category.</p>
                    ) : null}

                    {groupedItems[categoryId].map((item) => {
                      const isConnecting = connectingAuthConfigId === item.authConfigId;
                      return (
                        <article key={item.authConfigId} className="stitch-integration-row">
                          <StitchAppLogo slug={item.toolkitSlug} className="stitch-app-logo" alt={`${item.toolkitName} logo`} />
                          <div className="stitch-card-body">
                            <p className="stitch-card-title">{item.toolkitName}</p>
                            <p className="stitch-card-subtitle">{item.name} • {item.authScheme ?? "oauth"}</p>
                          </div>

                          {item.isActive ? (
                            <span className="stitch-connected-pill">Connected</span>
                          ) : (
                            <button
                              type="button"
                              className="stitch-mini-btn is-primary"
                              aria-label={isConnecting ? `Connecting ${item.toolkitName}` : `Connect ${item.toolkitName}`}
                              onClick={() => onConnectApp(item.authConfigId)}
                              disabled={isConnecting}
                            >
                              {isConnecting ? `Connecting ${item.toolkitName}` : `Connect ${item.toolkitName}`}
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </details>
              ))}
            </section>

            <details className="stitch-advanced" open={defaultSection === "timeline"}>
              <summary>
                <span>Advanced settings</span>
                <span className="stitch-accordion-count">Optional</span>
              </summary>

              <div className="stitch-advanced-body">
                <section className="stitch-settings-panel stitch-settings-panel-advanced">
                  <div className="stitch-settings-panel-head">
                    <h3>Session Controls</h3>
                    <p className="stitch-settings-meta">{sessionId ?? "no session"}</p>
                  </div>

                  <div className="stitch-settings-actions">
                    {!isRunning ? (
                      <button className="stitch-mini-btn is-primary" type="button" onClick={onStart}>
                        Start Listening
                      </button>
                    ) : (
                      <button className="stitch-mini-btn is-danger" type="button" onClick={onStop}>
                        Stop Listening
                      </button>
                    )}
                    <button className="stitch-mini-btn is-neutral" type="button" onClick={onResetMemory} disabled={!canResetMemory}>
                      Reset Memory
                    </button>
                  </div>

                  <dl className="stitch-status-list">
                    <div>
                      <dt>Action</dt>
                      <dd>{actionStatusMessage ?? "No action updates yet."}</dd>
                    </div>
                    <div>
                      <dt>STT</dt>
                      <dd>{sttMessage ?? "No status yet."}</dd>
                    </div>
                    <div>
                      <dt>TTS Provider</dt>
                      <dd>{activeTtsProvider ?? "none"}</dd>
                    </div>
                  </dl>
                </section>

                <section className="stitch-settings-panel stitch-settings-panel-advanced">
                  <h3>Voice Runtime</h3>
                  <dl className="stitch-status-list">
                    <div>
                      <dt>Connection</dt>
                      <dd>{voiceRuntime.connection}</dd>
                    </div>
                    <div>
                      <dt>Listener</dt>
                      <dd>{voiceRuntime.listening}</dd>
                    </div>
                    <div>
                      <dt>Microphone</dt>
                      <dd>{voiceRuntime.microphone}</dd>
                    </div>
                    <div>
                      <dt>Stage</dt>
                      <dd>{voiceRuntime.stage}</dd>
                    </div>
                    <div>
                      <dt>Audio Input</dt>
                      <dd>{voiceRuntime.audioInput}</dd>
                    </div>
                  </dl>
                </section>

                <section className="stitch-settings-panel stitch-settings-panel-advanced">
                  <h3>Catalog & Integrations</h3>
                  <dl className="stitch-status-list">
                    <div>
                      <dt>Visible</dt>
                      <dd>{appSummary.visible}</dd>
                    </div>
                    <div>
                      <dt>Total Apps</dt>
                      <dd>{appSummary.total}</dd>
                    </div>
                    <div>
                      <dt>Connected</dt>
                      <dd>{appSummary.connected}</dd>
                    </div>
                    <div>
                      <dt>Not Connected</dt>
                      <dd>{appSummary.notConnected}</dd>
                    </div>
                    <div>
                      <dt>Filtered Out</dt>
                      <dd>{appSummary.hidden}</dd>
                    </div>
                    <div>
                      <dt>Search</dt>
                      <dd>{appsSearch.trim().length > 0 ? appsSearch : "none"}</dd>
                    </div>
                    <div>
                      <dt>Connecting</dt>
                      <dd>{appSummary.pendingName}</dd>
                    </div>
                  </dl>
                </section>

                <section className="stitch-settings-panel stitch-settings-panel-advanced">
                  <h3>Transcript Snapshot</h3>
                  <dl className="stitch-status-list">
                    <div>
                      <dt>You (partial)</dt>
                      <dd>{transcriptSnapshot.userPartial}</dd>
                    </div>
                    <div>
                      <dt>You (final)</dt>
                      <dd>{transcriptSnapshot.userFinal}</dd>
                    </div>
                    <div>
                      <dt>Agent (partial)</dt>
                      <dd>{transcriptSnapshot.agentPartial}</dd>
                    </div>
                    <div>
                      <dt>Agent (final)</dt>
                      <dd>{transcriptSnapshot.agentFinal}</dd>
                    </div>
                  </dl>
                </section>

                <section className="stitch-settings-panel stitch-settings-panel-advanced">
                  <h3>Runtime Diagnostics</h3>
                  <dl className="stitch-status-list">
                    {providerDiagnostics.map((item) => (
                      <div key={item.label}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>

                <section className="stitch-settings-panel stitch-settings-panel-advanced">
                  <h3>Timeline</h3>
                  <p className="stitch-settings-meta">{timelineSourceLabel}</p>
                  {timelinePreview.length === 0 ? (
                    <p className="stitch-settings-hint">No action events yet.</p>
                  ) : (
                    <ul className="stitch-timeline-list">
                      {timelinePreview.map((item) => (
                        <li key={item.id} className="stitch-timeline-item">
                          <p className="stitch-timeline-type">{item.type}</p>
                          <p className="stitch-timeline-message">{item.message}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </details>
          </div>

          <footer className="stitch-settings-footer">
            <button className="stitch-settings-signout" type="button" onClick={onSignOut}>
              Sign Out
            </button>
          </footer>
        </div>
      </aside>
    </>
  );
}

function formatAudioLevel(value: number): string {
  const normalized = Math.max(0, Math.min(1, value));
  return `${Math.round(normalized * 100)}%`;
}

function previewSettingValue(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.length > 90 ? `${trimmed.slice(0, 87)}...` : trimmed;
}
