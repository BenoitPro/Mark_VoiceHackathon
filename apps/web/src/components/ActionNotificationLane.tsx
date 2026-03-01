import type { ActionDraft } from "@mark/contracts";

import type { TaskNotification } from "../uiTypes";
import { ActionNotificationCard } from "./ActionNotificationCard";

type ActionNotificationLaneProps = {
  notifications: TaskNotification[];
  pendingAction: ActionDraft | null;
  onApprovePending: () => void;
  onRejectPending: () => void;
  onViewAll: () => void;
};

export function ActionNotificationLane({
  notifications,
  pendingAction,
  onApprovePending,
  onRejectPending,
  onViewAll
}: ActionNotificationLaneProps) {
  const hasNotifications = notifications.length > 0;
  const hasOnlyPlaceholders = hasNotifications && notifications.every(isPlaceholderNotification);
  const laneClassName = `task-lane ${hasNotifications ? "" : "is-empty-lane"} ${hasOnlyPlaceholders ? "is-placeholder-lane" : ""}`.trim();

  return (
    <aside className={laneClassName} aria-label="Task notifications">
      <header className="task-lane-head">
        <h2>Recent Activity</h2>
        <button type="button" className="task-lane-view-all" onClick={onViewAll}>
          View all
        </button>
      </header>

      {!hasNotifications ? (
        <article className="task-empty-state" aria-live="polite">
          <p className="task-empty-title">No recent actions yet.</p>
          <p className="task-empty-message">Speak to generate your first activity item.</p>
        </article>
      ) : null}

      {notifications.map((notification) => {
        const isPlaceholder = isPlaceholderNotification(notification);
        const showApprovalControls =
          !!pendingAction &&
          notification.actionId === pendingAction.actionId &&
          notification.revisionId === pendingAction.revisionId &&
          notification.tone === "approval";

        return (
          <ActionNotificationCard
            key={notification.id}
            notification={notification}
            isPlaceholder={isPlaceholder}
            showApprovalControls={showApprovalControls}
            onApprovePending={onApprovePending}
            onRejectPending={onRejectPending}
          />
        );
      })}
    </aside>
  );
}

function isPlaceholderNotification(notification: TaskNotification): boolean {
  return notification.type.startsWith("placeholder.");
}
