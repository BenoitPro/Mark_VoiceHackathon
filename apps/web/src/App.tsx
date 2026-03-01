import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import type {
  ActionHistoryItem,
  AuthMeResponse,
  BillingCheckoutResponse,
  BillingStatusResponse,
  ComposioCatalogItem,
  ComposioConnectionItem,
  ComposioConnectLinkResponse,
  TelemetryEventName
} from "@mark/contracts";

import { StatusAlerts } from "./components/StatusAlerts";
import type { ProviderDiagnosticItem } from "./components/types";
import { VoiceStage } from "./components/VoiceStage";
import { buildApiUrl, normalizeApiBaseUrl } from "./apiBaseUrl";
import { supabase } from "./supabase";
import type { CatalogListItem } from "./tabs/AppsTab";
import type { TimelineViewItem } from "./tabs/TimelineTab";
import { useVoiceAgent } from "./useVoiceAgent";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const MARKETING_CHECKOUT_URL =
  typeof import.meta.env.VITE_STRIPE_CHECKOUT_URL === "string" && import.meta.env.VITE_STRIPE_CHECKOUT_URL.trim().length > 0
    ? import.meta.env.VITE_STRIPE_CHECKOUT_URL.trim()
    : null;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthMeResponse | null>(null);
  const [catalog, setCatalog] = useState<ComposioCatalogItem[]>([]);
  const [connections, setConnections] = useState<ComposioConnectionItem[]>([]);
  const [history, setHistory] = useState<ActionHistoryItem[]>([]);
  const [billing, setBilling] = useState<BillingStatusResponse | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [connectingAuthConfigId, setConnectingAuthConfigId] = useState<string | null>(null);
  const [connectedBanner, setConnectedBanner] = useState<string | null>(null);
  const [pendingConnectionRefresh, setPendingConnectionRefresh] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const accessToken = session?.access_token ?? null;

  const hasTrackedVisitRef = useRef(false);
  const hasTrackedSignupRef = useRef(false);
  const hasTrackedGmailConnectedRef = useRef(false);
  const hasTrackedFirstTriageRef = useRef(false);

  const agent = useVoiceAgent(audioRef.current, accessToken);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected") === "1";
    const status = (params.get("status") ?? "").toLowerCase();

    if (connected || status === "success") {
      setConnectedBanner("Connection completed successfully.");
      setPendingConnectionRefresh(true);
    } else if (status === "failed") {
      setError("Connection failed in Composio. Please try again.");
    }

    if (connected || status) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (hasTrackedVisitRef.current) {
      return;
    }
    hasTrackedVisitRef.current = true;
    void trackTelemetry("visit", null, {
      source: "web"
    });
  }, []);

  useEffect(() => {
    if (!accessToken) {
      setUser(null);
      setCatalog([]);
      setConnections([]);
      setHistory([]);
      setBilling(null);
      return;
    }

    void refreshAuthedData(accessToken);
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !pendingConnectionRefresh) {
      return;
    }
    void refreshAuthedData(accessToken).finally(() => {
      setPendingConnectionRefresh(false);
    });
  }, [accessToken, pendingConnectionRefresh]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    const interval = window.setInterval(() => {
      void loadConnections(accessToken);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [accessToken]);

  const isGmailConnected = useMemo(() => {
    return connections.some((connection) => {
      return connection.toolkitSlug.toLowerCase() === "gmail" && connection.status.toUpperCase() === "ACTIVE";
    });
  }, [connections]);

  useEffect(() => {
    if (!accessToken || hasTrackedSignupRef.current) {
      return;
    }
    hasTrackedSignupRef.current = true;
    void trackTelemetry("signup", accessToken, {
      hasSession: true
    });
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !isGmailConnected || hasTrackedGmailConnectedRef.current) {
      return;
    }
    hasTrackedGmailConnectedRef.current = true;
    void trackTelemetry("gmail_connected", accessToken, {
      source: "app_connections"
    });
  }, [accessToken, isGmailConnected]);

  useEffect(() => {
    if (!accessToken || hasTrackedFirstTriageRef.current) {
      return;
    }
    if (!/\bi scanned\b/i.test(agent.agentFinal) || !/\bunread inbox emails\b/i.test(agent.agentFinal)) {
      return;
    }

    hasTrackedFirstTriageRef.current = true;
    void trackTelemetry("first_triage", accessToken, {
      source: "voice"
    });
  }, [accessToken, agent.agentFinal]);

  const filteredCatalog = useMemo(() => {
    const needle = catalogSearch.trim().toLowerCase();
    if (!needle) {
      return catalog;
    }
    return catalog.filter((item) => {
      return (
        item.name.toLowerCase().includes(needle) ||
        item.toolkitName.toLowerCase().includes(needle) ||
        item.toolkitSlug.toLowerCase().includes(needle)
      );
    });
  }, [catalog, catalogSearch]);

  const connectionsByAuthConfigId = useMemo(() => {
    const map = new Map<string, ComposioConnectionItem>();
    for (const connection of connections) {
      const authConfigId = connection.authConfigId;
      if (!authConfigId) {
        continue;
      }
      const existing = map.get(authConfigId);
      if (!existing || connectionPriority(connection.status) > connectionPriority(existing.status)) {
        map.set(authConfigId, connection);
      }
    }
    return map;
  }, [connections]);

  const connectionsByToolkitSlug = useMemo(() => {
    const map = new Map<string, ComposioConnectionItem>();
    for (const connection of connections) {
      const existing = map.get(connection.toolkitSlug);
      if (!existing || connectionPriority(connection.status) > connectionPriority(existing.status)) {
        map.set(connection.toolkitSlug, connection);
      }
    }
    return map;
  }, [connections]);

  const catalogList = useMemo<CatalogListItem[]>(() => {
    return filteredCatalog.map((item) => {
      const connection =
        connectionsByAuthConfigId.get(item.authConfigId) ?? connectionsByToolkitSlug.get(item.toolkitSlug);
      const isActive = connection?.status.toUpperCase() === "ACTIVE";
      return {
        authConfigId: item.authConfigId,
        toolkitSlug: item.toolkitSlug,
        toolkitName: item.toolkitName,
        name: item.name,
        authScheme: item.authScheme,
        statusLabel: connection ? connection.status.toLowerCase() : "not connected",
        isActive
      };
    });
  }, [connectionsByAuthConfigId, connectionsByToolkitSlug, filteredCatalog]);

  const timelineView = useMemo(() => {
    if (agent.actionTimeline.length > 0) {
      return {
        sourceLabel: "Live session events",
        items: agent.actionTimeline.slice(0, 16).map<TimelineViewItem>((item) => ({
          id: item.id,
          type: item.type,
          message: item.message,
          createdAt: item.createdAt
        }))
      };
    }

    if (history.length > 0) {
      return {
        sourceLabel: "Persisted action history",
        items: history.slice(0, 16).map<TimelineViewItem>((item) => ({
          id: item.id,
          type: item.eventType,
          message: summarizePayload(item.payload),
          createdAt: item.createdAt
        }))
      };
    }

    return {
      sourceLabel: "No events yet",
      items: []
    };
  }, [agent.actionTimeline, history]);

  const providerDiagnostics = useMemo<ProviderDiagnosticItem[]>(() => {
    if (!agent.health) {
      return [
        { label: "STT", value: "checking" },
        { label: "LLM", value: "checking" },
        { label: "Composio", value: "checking" },
        { label: "Auth", value: "checking" },
        { label: "TTS", value: "checking" }
      ];
    }

    return [
      { label: "STT", value: agent.health.sttConfigured ? "ready" : "missing" },
      { label: "LLM", value: agent.health.llmConfigured ? "ready" : "missing" },
      { label: "Composio", value: agent.health.composioConfigured ? "ready" : "missing" },
      { label: "Auth", value: agent.health.authConfigured ? "ready" : "missing" },
      { label: "TTS", value: agent.health.ttsConfigured ? "ready" : "missing" },
      {
        label: "Speechmatics TTS",
        value: agent.health.ttsProviders?.speechmaticsConfigured ? "ready" : "missing"
      },
      {
        label: "ElevenLabs TTS",
        value: agent.health.ttsProviders?.elevenLabsConfigured ? "ready" : "missing"
      }
    ];
  }, [agent.health]);

  const onboardingSteps = useMemo(() => {
    return [
      {
        id: "signin",
        label: "Sign in with Google",
        done: Boolean(session)
      },
      {
        id: "connect",
        label: "Connect Gmail",
        done: isGmailConnected
      },
      {
        id: "voice",
        label: "Run first voice triage",
        done: agent.actionTimeline.length > 0 || /\bi scanned\b/i.test(agent.agentFinal)
      }
    ];
  }, [agent.actionTimeline.length, agent.agentFinal, isGmailConnected, session]);

  const startBlockedReason = !isGmailConnected
    ? "Connect an active Gmail integration before starting voice triage."
    : null;

  const signInWithGoogle = async (): Promise<void> => {
    if (!supabase) {
      setError("Supabase is not configured in the web app.");
      return;
    }
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin
      }
    });
    if (signInError) {
      setError(signInError.message);
    }
  };

  const signOut = async (): Promise<void> => {
    if (!supabase) {
      return;
    }
    await agent.stop();
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setError(signOutError.message);
    }
  };

  const connectApp = async (authConfigId: string): Promise<void> => {
    if (!accessToken) {
      return;
    }
    setConnectingAuthConfigId(authConfigId);
    try {
      const payload = await authedFetch<ComposioConnectLinkResponse>(`/v1/composio/connect-link`, accessToken, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ authConfigId })
      });

      const popup = window.open(payload.redirectUrl, "_blank", "noopener,noreferrer");
      if (!popup) {
        window.location.href = payload.redirectUrl;
        return;
      }

      setConnectedBanner("Connection flow opened in a new tab. Finish it there, then return here.");
      setPendingConnectionRefresh(true);
      void loadConnections(accessToken);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setConnectingAuthConfigId(null);
    }
  };

  const startCheckout = async (): Promise<void> => {
    if (accessToken) {
      try {
        const payload = await authedFetch<BillingCheckoutResponse>("/v1/billing/checkout-link", accessToken, {
          method: "POST"
        });
        void trackTelemetry("checkout_clicked", accessToken, {
          source: "authed"
        });
        window.open(payload.checkoutUrl, "_blank", "noopener,noreferrer");
        return;
      } catch (err) {
        setError(toErrorMessage(err));
      }
    }

    if (MARKETING_CHECKOUT_URL) {
      void trackTelemetry("checkout_clicked", accessToken, {
        source: "landing"
      });
      window.open(MARKETING_CHECKOUT_URL, "_blank", "noopener,noreferrer");
      return;
    }

    setError("Checkout is not configured yet.");
  };

  return (
    <div className="page">
      <main className="shell">
        {!session ? (
          <section className="landing-shell" aria-label="Mark Gmail voice triage landing">
            <header className="landing-hero card">
              <p className="eyebrow">Gmail triage voice-first</p>
              <h1>Inbox cleared by voice in minutes.</h1>
              <p className="muted">
                Mark listens, triages unread Gmail, drafts replies, and asks approval before any send action.
              </p>
              <div className="landing-cta-row">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    void signInWithGoogle();
                  }}
                >
                  Continue with Google
                </button>
                <button className="btn" onClick={() => void startCheckout()}>
                  Buy now
                </button>
              </div>
            </header>

            <section className="landing-grid">
              <article className="card">
                <h2>How it works</h2>
                <ol className="landing-list">
                  <li>Connect Gmail once</li>
                  <li>Ask for inbox triage by voice</li>
                  <li>Approve replies before send</li>
                </ol>
              </article>

              <article className="card">
                <h2>Pricing</h2>
                <p><strong>Starter:</strong> Trial with core triage workflow</p>
                <p><strong>Pro:</strong> Paid plan with production support and priority fixes</p>
              </article>

              <article className="card">
                <h2>FAQ</h2>
                <p><strong>Will Mark auto-send without me?</strong> No. Mutating actions stay approval-gated.</p>
                <p><strong>Can I use it from mobile?</strong> Yes, the interface is mobile-first.</p>
              </article>
            </section>

            {!supabase ? <p className="stitch-auth-error">Missing `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`.</p> : null}
            <StatusAlerts connectedBanner={connectedBanner} errorMessage={error} />
          </section>
        ) : (
          <>
            <section className="card onboarding-strip" aria-label="Onboarding checklist">
              <p className="eyebrow">Onboarding</p>
              <h2>Get to first value fast</h2>
              <ul className="onboarding-list">
                {onboardingSteps.map((step) => (
                  <li key={step.id} className={step.done ? "is-done" : ""}>
                    <span>{step.done ? "Done" : "Pending"}</span>
                    <span>{step.label}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="card billing-strip" aria-label="Billing status">
              <p>
                Plan: <strong>{billing?.plan ?? "trial"}</strong>
              </p>
              {billing?.plan !== "paid" ? (
                <button className="btn btn-primary btn-compact" type="button" onClick={() => void startCheckout()}>
                  Upgrade with Stripe
                </button>
              ) : (
                <p className="muted">Paid plan active</p>
              )}
            </section>

            <StatusAlerts
              connectedBanner={connectedBanner}
              errorMessage={agent.error ?? error}
              onRetry={
                accessToken
                  ? () => {
                      void refreshAuthedData(accessToken);
                    }
                  : null
              }
              retryLabel="Retry loading"
            />
            <VoiceStage
              connected={agent.connected}
              isRunning={agent.isRunning}
              isMicMuted={agent.isMicMuted}
              voiceState={agent.voiceState}
              audioLevel={agent.audioLevel}
              sessionId={agent.sessionId}
              userPartial={agent.userPartial}
              userFinal={agent.userFinal}
              agentPartial={agent.agentPartial}
              agentFinal={agent.agentFinal}
              pendingAction={agent.pendingAction}
              actionStatus={agent.actionStatus}
              actionTimeline={agent.actionTimeline}
              sttMessage={agent.sttStatus?.message ?? null}
              actionStatusMessage={agent.actionStatus?.message ?? null}
              activeTtsProvider={agent.activeTtsProvider}
              providerDiagnostics={providerDiagnostics}
              startBlockedReason={startBlockedReason}
              onStart={() => {
                void agent.start();
              }}
              onStop={() => {
                void agent.stop();
              }}
              onToggleMic={agent.toggleMic}
              onResetMemory={agent.resetMemory}
              onSignOut={() => {
                void signOut();
              }}
              onApprovePending={agent.approvePending}
              onRejectPending={() => agent.rejectPending("Rejected from notification card.")}
              loadingApps={loadingCatalog}
              appsSearch={catalogSearch}
              onAppsSearchChange={setCatalogSearch}
              appsItems={catalogList}
              connectingAuthConfigId={connectingAuthConfigId}
              onConnectApp={(authConfigId) => {
                void connectApp(authConfigId);
              }}
              timelineSourceLabel={timelineView.sourceLabel}
              timelineItems={timelineView.items}
            />
          </>
        )}
      </main>

      <audio ref={audioRef} hidden playsInline />
    </div>
  );

  async function refreshAuthedData(token: string): Promise<void> {
    setLoadingCatalog(true);
    setError(null);
    try {
      const [me, nextCatalog, nextConnections, nextHistory, nextBilling] = await Promise.all([
        authedFetch<AuthMeResponse>("/v1/auth/me", token),
        authedFetch<ComposioCatalogItem[]>("/v1/composio/catalog", token),
        authedFetch<ComposioConnectionItem[]>("/v1/composio/connections", token),
        authedFetch<{ items: ActionHistoryItem[] }>("/v1/actions/history", token),
        authedFetch<BillingStatusResponse>("/v1/billing/status", token)
      ]);

      setUser(me);
      setCatalog(nextCatalog);
      setConnections(nextConnections);
      setHistory(nextHistory.items);
      setBilling(nextBilling);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoadingCatalog(false);
    }
  }

  async function loadConnections(token: string): Promise<void> {
    try {
      const nextConnections = await authedFetch<ComposioConnectionItem[]>("/v1/composio/connections", token);
      setConnections(nextConnections);
    } catch {
      // Keep last successful snapshot.
    }
  }
}

async function authedFetch<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(API_BASE_URL, path), {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

async function trackTelemetry(
  event: TelemetryEventName,
  accessToken: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  await fetch(buildApiUrl(API_BASE_URL, "/v1/telemetry/events"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify({ event, metadata })
  }).catch(() => undefined);
}

function summarizePayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return "Event logged.";
  }
  return keys
    .slice(0, 4)
    .map((key) => `${key}: ${preview(payload[key])}`)
    .join(" • ");
}

function preview(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 48 ? `${value.slice(0, 45)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[structured]";
}

function connectionPriority(status: string): number {
  switch (status.trim().toUpperCase()) {
    case "ACTIVE":
      return 5;
    case "INITIALIZING":
    case "INITIATED":
      return 4;
    case "INACTIVE":
      return 3;
    case "EXPIRED":
      return 2;
    case "FAILED":
      return 1;
    default:
      return 0;
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "Unknown error";
}
