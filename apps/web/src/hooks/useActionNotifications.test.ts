import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionDraft, ActionStatusEvent } from "@mark/contracts";

import { useActionNotifications } from "./useActionNotifications";

const NOW = "2026-03-01T08:00:00.000Z";

describe("useActionNotifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps action proposed events to approval notifications", () => {
    const { result } = renderHook(() =>
      useActionNotifications({
        actionTimeline: [
          createTimelineItem({
            id: "t-1",
            type: "action.proposed",
            message: "Draft ready for approval."
          })
        ],
        pendingAction: null,
        actionStatus: null
      })
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.tone).toBe("approval");
    expect(result.current[0]?.message).toBe("Draft ready for approval.");
  });

  it("deduplicates repeated action.status notifications by action/revision/type", () => {
    const initialTimeline = [
      createTimelineItem({
        id: "status-1",
        type: "action.status",
        message: "Executing task."
      })
    ];

    const { result, rerender } = renderHook(
      ({
        actionTimeline,
        pendingAction,
        actionStatus
      }: {
        actionTimeline: ReturnType<typeof createTimelineItem>[];
        pendingAction: ActionDraft | null;
        actionStatus: ActionStatusEvent | null;
      }) =>
        useActionNotifications({
          actionTimeline,
          pendingAction,
          actionStatus
        }),
      {
        initialProps: {
          actionTimeline: initialTimeline,
          pendingAction: null,
          actionStatus: null
        }
      }
    );

    rerender({
      actionTimeline: [
        createTimelineItem({
          id: "status-2",
          type: "action.status",
          message: "Still executing task."
        }),
        ...initialTimeline
      ],
      pendingAction: null,
      actionStatus: null
    });

    const statusNotifications = result.current.filter((item) => item.type === "action.status");
    expect(statusNotifications).toHaveLength(1);
    expect(statusNotifications[0]?.message).toBe("Still executing task.");
  });

  it("keeps terminal notifications in recent activity history", () => {
    const { result } = renderHook(() =>
      useActionNotifications({
        actionTimeline: [
          createTimelineItem({
            id: "done-1",
            type: "action.executed",
            message: "Task done."
          })
        ],
        pendingAction: null,
        actionStatus: null
      })
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.visualState).toBe("visible");

    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(result.current[0]?.visualState).toBe("visible");

    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(result.current).toHaveLength(1);
  });

  it("keeps approval notifications in history after pending action is cleared", () => {
    const pendingAction = createPendingAction();
    type PendingActionProps = { activePendingAction: ActionDraft | null };

    const { result, rerender } = renderHook(
      ({ activePendingAction }: PendingActionProps) =>
        useActionNotifications({
          actionTimeline: [],
          pendingAction: activePendingAction,
          actionStatus: null
        }),
      {
        initialProps: {
          activePendingAction: null
        } as PendingActionProps
      }
    );

    rerender({ activePendingAction: pendingAction });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.type).toBe("action.proposed");

    rerender({ activePendingAction: null });
    act(() => {
      vi.advanceTimersByTime(320);
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.visualState).toBe("visible");
  });
});

function createTimelineItem(overrides: {
  id: string;
  type: string;
  message: string;
}): {
  id: string;
  actionId: string;
  revisionId: string;
  type: string;
  message: string;
  createdAt: string;
} {
  return {
    id: overrides.id,
    actionId: "action-1",
    revisionId: "revision-1",
    type: overrides.type,
    message: overrides.message,
    createdAt: NOW
  };
}

function createPendingAction(): ActionDraft {
  return {
    actionId: "action-1",
    revisionId: "revision-1",
    status: "pending_approval",
    toolSlug: "send_email",
    toolkitSlug: "gmail",
    connectedAccountId: "acct-1",
    summary: "Draft ready for approval.",
    arguments: {
      to: "ops@example.com"
    },
    requiresApproval: true,
    createdAt: NOW,
    updatedAt: NOW
  };
}
