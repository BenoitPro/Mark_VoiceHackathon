import type { VoiceState } from "@mark/contracts";

type VoiceTabProps = {
  connected: boolean;
  voiceState: VoiceState;
  sttCode: string | null;
  sessionId: string | null;
  isRunning: boolean;
  canResetMemory: boolean;
  userFinal: string;
  userPartial: string;
  agentFinal: string;
  agentPartial: string;
  audioLevel: number;
  onStart: () => void;
  onStop: () => void;
  onResetMemory: () => void;
};

export function VoiceTab({
  connected,
  voiceState,
  sttCode,
  sessionId,
  isRunning,
  canResetMemory,
  userFinal,
  userPartial,
  agentFinal,
  agentPartial,
  audioLevel,
  onStart,
  onStop,
  onResetMemory
}: VoiceTabProps) {
  const level = Math.max(0, Math.min(1, audioLevel * 4));

  return (
    <section className="tab-flow" aria-label="Voice Session">
      <article className="card">
        <h2>Session Snapshot</h2>
        <dl className="status-grid compact-text">
          <div>
            <dt>Socket</dt>
            <dd>{connected ? "connected" : "disconnected"}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{voiceState}</dd>
          </div>
          <div>
            <dt>STT</dt>
            <dd>{sttCode ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{sessionId ?? "pending"}</dd>
          </div>
        </dl>
      </article>

      <article className="card sticky-controls">
        <div className="control-row">
          {!isRunning ? (
            <button className="btn btn-primary btn-large" onClick={onStart}>
              Start Listening
            </button>
          ) : (
            <button className="btn btn-danger btn-large" onClick={onStop}>
              Stop Listening
            </button>
          )}
          <button className="btn" onClick={onResetMemory} disabled={!canResetMemory}>
            Reset Memory
          </button>
        </div>
        <p className="compact-text muted">
          Read-only tools execute automatically. Mutating tools stay in draft until you approve or reject.
        </p>
        <div className="voice-meter-wrap" aria-live="off">
          <label htmlFor="voice-level">Mic level</label>
          <meter id="voice-level" min={0} max={1} value={level} />
        </div>
      </article>

      <div className="transcript-grid">
        <article className="card transcript-panel">
          <header>
            <h2>Your Voice</h2>
            <p className="compact-text muted">Live transcript</p>
          </header>
          <p className="final-text">{userFinal || "Speak to begin."}</p>
          <p className="partial-text">{userPartial || " "}</p>
        </article>

        <article className="card transcript-panel">
          <header>
            <h2>Agent Voice</h2>
            <p className="compact-text muted">Live response</p>
          </header>
          <p className="final-text">{agentFinal || "Waiting for your first prompt."}</p>
          <p className="partial-text">{agentPartial || " "}</p>
        </article>
      </div>
    </section>
  );
}
