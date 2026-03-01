import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ActionDraft } from "@mark/contracts";

import { PendingActionCard } from "./PendingActionCard";

const draft: ActionDraft = {
  actionId: "action-1",
  revisionId: "revision-1",
  status: "pending_approval",
  toolSlug: "gmail_send_email",
  toolkitSlug: "gmail",
  connectedAccountId: "acct-1",
  summary: "Send project update to product team",
  arguments: {
    to: "team@example.com",
    subject: "Daily update"
  },
  requiresApproval: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe("PendingActionCard", () => {
  it("shows empty state when there is no pending action", () => {
    render(<PendingActionCard pendingAction={null} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByText("No pending draft. Ask for a write action to open one.")).toBeInTheDocument();
  });

  it("emits approve and reject actions", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(<PendingActionCard pendingAction={draft} onApprove={onApprove} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
