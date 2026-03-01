import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BottomNav } from "./BottomNav";

describe("BottomNav", () => {
  it("renders four tabs and marks the active tab", () => {
    const onSelectTab = vi.fn();
    render(<BottomNav activeTab="voice" onSelectTab={onSelectTab} />);

    expect(screen.getByRole("button", { name: "Voice" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Actions" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Apps" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Timeline" })).toBeInTheDocument();
  });

  it("calls selection callback when a tab is pressed", async () => {
    const user = userEvent.setup();
    const onSelectTab = vi.fn();

    render(<BottomNav activeTab="voice" onSelectTab={onSelectTab} />);
    await user.click(screen.getByRole("button", { name: "Apps" }));

    expect(onSelectTab).toHaveBeenCalledWith("apps");
  });
});
