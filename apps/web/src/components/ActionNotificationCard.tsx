import type { TaskNotification } from "../uiTypes";
import { StitchAppLogo } from "./stitch/stitch-app-logo";

type ActionNotificationCardProps = {
  notification: TaskNotification;
  isPlaceholder?: boolean;
  showApprovalControls: boolean;
  onApprovePending: () => void;
  onRejectPending: () => void;
};

export function ActionNotificationCard({
  notification,
  isPlaceholder = false,
  showApprovalControls,
  onApprovePending,
  onRejectPending
}: ActionNotificationCardProps) {
  const logoSlug = resolveLogoSlug(notification.platformLabel);
  const title = EVENT_LABELS[notification.type] ?? "Action update";
  const age = formatAge(notification.createdAt);

  return (
    <article
      className={`task-notification tone-${notification.tone} state-${notification.visualState} ${isPlaceholder ? "is-placeholder" : ""}`}
      data-tone={notification.tone}
      aria-live={isPlaceholder ? "off" : notification.tone === "error" ? "assertive" : "polite"}
    >
      <div className="task-notification-row">
        <span className="task-logo-wrap">
          <StitchAppLogo slug={logoSlug} className="task-logo" alt={`${logoSlug} logo`} />
        </span>
        <div className="task-notification-main">
          <header className="task-notification-head">
            <p className="task-event">{title}</p>
            <p className="task-age">{age}</p>
          </header>
          <p className="task-message">{notification.message}</p>
        </div>
      </div>

      {showApprovalControls ? (
        <div className="task-approval">
          <p className="compact-text">
            Say "approve" or "reject", or decide here:
          </p>
          <div className="task-approval-actions">
            <button className="btn btn-primary btn-compact" onClick={onApprovePending}>
              Approve
            </button>
            <button className="btn btn-compact" onClick={onRejectPending}>
              Reject
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

const EVENT_LABELS: Record<string, string> = {
  "action.proposed": "Follow-up drafted",
  "action.revised": "Draft revised",
  "action.status": "In progress",
  "action.executed": "Completed",
  "action.rejected": "Rejected",
  "action.failed": "Failed",
  "placeholder.follow-up": "Follow-up drafted",
  "placeholder.message": "Message from Sarah",
  "placeholder.notes": "TechCorp Demo Prep",
  "placeholder.sync": "Weekly sync prepared",
  "placeholder.brief": "Client brief queued",
  "placeholder.budget": "Budget review pending",
  "placeholder.slack_manager": "Slack from your manager",
  "placeholder.linkedin_client": "LinkedIn client message",
  "placeholder.email_deal": "Big deal email"
};

function resolveLogoSlug(platformLabel: string): string {
  const normalized = platformLabel.trim().toLowerCase();
  if (!normalized) {
    return "generic";
  }
  if (normalized.includes("_")) {
    return normalized.split("_")[0] ?? normalized;
  }
  if (normalized.includes("-")) {
    return normalized.split("-")[0] ?? normalized;
  }
  return normalized;
}

function formatAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) {
    return "now";
  }
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
  if (deltaSeconds < 60) {
    return "now";
  }
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d`;
}
