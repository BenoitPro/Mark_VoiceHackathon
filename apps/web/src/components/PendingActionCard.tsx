import type { ActionDraft } from "@mark/contracts";

type PendingActionCardProps = {
  pendingAction: ActionDraft | null;
  onApprove: () => void;
  onReject: () => void;
};

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) {
    return "No arguments";
  }
  return keys
    .slice(0, 3)
    .map((key) => `${key}`)
    .join(" • ");
}

export function PendingActionCard({ pendingAction, onApprove, onReject }: PendingActionCardProps) {
  return (
    <article className="card">
      <header className="card-head">
        <h2>Pending Action</h2>
        <p className="compact-text muted">{pendingAction ? "Awaiting decision" : "None"}</p>
      </header>

      {!pendingAction ? (
        <p className="compact-text muted">No pending draft. Ask for a write action to open one.</p>
      ) : (
        <div className="stack-md">
          <p className="pending-tool">{pendingAction.toolSlug}</p>
          <p className="compact-text">{pendingAction.summary}</p>
          <p className="compact-text muted">Args: {summarizeArgs(pendingAction.arguments)}</p>
          <div className="control-row">
            <button className="btn btn-primary" onClick={onApprove}>
              Approve
            </button>
            <button className="btn" onClick={onReject}>
              Reject
            </button>
          </div>
          <details className="payload-details">
            <summary>View JSON payload</summary>
            <pre>{JSON.stringify(pendingAction.arguments, null, 2)}</pre>
          </details>
        </div>
      )}
    </article>
  );
}
