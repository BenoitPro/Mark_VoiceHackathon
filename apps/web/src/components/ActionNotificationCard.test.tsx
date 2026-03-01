import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskNotification } from "../uiTypes";
import { ActionNotificationCard } from "./ActionNotificationCard";

describe("ActionNotificationCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves known app slug to remote logo URL", () => {
    render(
      <ActionNotificationCard
        notification={createNotification({ platformLabel: "gmail_send_email" })}
        showApprovalControls={false}
        onApprovePending={vi.fn()}
        onRejectPending={vi.fn()}
      />
    );

    const logo = screen.getByRole("img", { name: "gmail logo" });
    expect(logo).toHaveAttribute("src", "https://cdn.simpleicons.org/gmail/EA4335");
  });

  it("falls back to generic remote logo when slug is unknown", () => {
    render(
      <ActionNotificationCard
        notification={createNotification({ platformLabel: "unknown_tool" })}
        showApprovalControls={false}
        onApprovePending={vi.fn()}
        onRejectPending={vi.fn()}
      />
    );

    const logo = screen.getByRole("img", { name: "unknown logo" });
    expect(logo).toHaveAttribute("src", "https://cdn.simpleicons.org/appstore/7A8CA9");
  });

  it("formats notification age using relative short labels", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-01T12:15:00.000Z").getTime());

    render(
      <ActionNotificationCard
        notification={createNotification({ createdAt: "2026-03-01T12:00:00.000Z" })}
        showApprovalControls={false}
        onApprovePending={vi.fn()}
        onRejectPending={vi.fn()}
      />
    );

    expect(screen.getByText("15m")).toBeInTheDocument();
  });

  it("shows approve/reject only when approval controls are enabled", async () => {
    const user = userEvent.setup();
    const onApprovePending = vi.fn();
    const onRejectPending = vi.fn();

    const { rerender } = render(
      <ActionNotificationCard
        notification={createNotification({ tone: "approval" })}
        showApprovalControls={false}
        onApprovePending={onApprovePending}
        onRejectPending={onRejectPending}
      />
    );

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();

    rerender(
      <ActionNotificationCard
        notification={createNotification({ tone: "approval" })}
        showApprovalControls
        onApprovePending={onApprovePending}
        onRejectPending={onRejectPending}
      />
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(onApprovePending).toHaveBeenCalledTimes(1);
    expect(onRejectPending).toHaveBeenCalledTimes(1);
  });
});

function createNotification(overrides: Partial<TaskNotification> = {}): TaskNotification {
  return {
    id: "notif-1",
    signature: "notif-1",
    actionId: "action-1",
    revisionId: "revision-1",
    type: "action.proposed",
    message: "Draft ready for approval",
    platformLabel: "gmail",
    tone: "working",
    visualState: "visible",
    createdAt: "2026-03-01T12:00:00.000Z",
    ...overrides
  };
}
