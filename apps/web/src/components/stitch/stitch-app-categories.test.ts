import { describe, expect, it } from "vitest";

import { categorizeAppSlug } from "./stitch-app-categories";

describe("categorizeAppSlug", () => {
  it("maps slack to messaging", () => {
    expect(categorizeAppSlug("slack")).toBe("messaging");
  });

  it("falls back to other for unknown slugs", () => {
    expect(categorizeAppSlug("unknown-tool")).toBe("other");
  });
});
