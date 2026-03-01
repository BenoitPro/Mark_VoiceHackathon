import { PendingActionCard } from "./PendingActionCard";
import type { ProviderDiagnosticItem } from "./types";

import type { ActionDraft } from "@mark/contracts";

type ActionsTabProps = {
  pendingAction: ActionDraft | null;
  onApprovePending: () => void;
  onRejectPending: () => void;
  actionStatusMessage: string | null;
  sttMessage: string | null;
  activeTtsProvider: string | null;
  providerDiagnostics: ProviderDiagnosticItem[];
};

export function ActionsTab({
  pendingAction,
  onApprovePending,
  onRejectPending,
  actionStatusMessage,
  sttMessage,
  activeTtsProvider,
  providerDiagnostics
}: ActionsTabProps) {
  return (
    <section className="tab-flow" aria-label="Actions">
      <PendingActionCard pendingAction={pendingAction} onApprove={onApprovePending} onReject={onRejectPending} />

      <article className="card">
        <h2>Runtime Status</h2>
        <dl className="status-list compact-text">
          <div>
            <dt>Action state</dt>
            <dd>{actionStatusMessage ?? "No action updates yet."}</dd>
          </div>
          <div>
            <dt>STT status</dt>
            <dd>{sttMessage ?? "No status yet."}</dd>
          </div>
          <div>
            <dt>TTS provider</dt>
            <dd>{activeTtsProvider ?? "none"}</dd>
          </div>
        </dl>
      </article>

      <article className="card">
        <details className="payload-details">
          <summary>Provider diagnostics</summary>
          <dl className="status-list compact-text stack-sm">
            {providerDiagnostics.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </article>
    </section>
  );
}
