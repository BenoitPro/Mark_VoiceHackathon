type StatusAlertsProps = {
  connectedBanner: string | null;
  errorMessage: string | null;
  onRetry?: (() => void) | null;
  retryLabel?: string;
};

export function StatusAlerts({ connectedBanner, errorMessage, onRetry = null, retryLabel = "Retry" }: StatusAlertsProps) {
  if (!connectedBanner && !errorMessage) {
    return null;
  }

  return (
    <section className="alerts" aria-live="polite">
      {connectedBanner ? <p className="alert alert-ok">{connectedBanner}</p> : null}
      {errorMessage ? (
        <div className="alert alert-error">
          <p>{errorMessage}</p>
          {onRetry ? (
            <button className="btn btn-compact btn-quiet" type="button" onClick={onRetry}>
              {retryLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
