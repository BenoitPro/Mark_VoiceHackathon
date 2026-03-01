type StatusAlertsProps = {
  connectedBanner: string | null;
  errorMessage: string | null;
};

export function StatusAlerts({ connectedBanner, errorMessage }: StatusAlertsProps) {
  if (!connectedBanner && !errorMessage) {
    return null;
  }

  return (
    <section className="alerts" aria-live="polite">
      {connectedBanner ? <p className="alert alert-ok">{connectedBanner}</p> : null}
      {errorMessage ? <p className="alert alert-error">{errorMessage}</p> : null}
    </section>
  );
}
