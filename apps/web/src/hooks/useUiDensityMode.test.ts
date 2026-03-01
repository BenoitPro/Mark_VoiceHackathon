import { describe, expect, it } from "vitest";

import { resolveUiDensityMode } from "./useUiDensityMode";

describe("resolveUiDensityMode", () => {
  it("returns mobile for phone widths", () => {
    expect(resolveUiDensityMode(360)).toBe("mobile");
  });

  it("returns tablet for mid-range widths", () => {
    expect(resolveUiDensityMode(800)).toBe("tablet");
  });

  it("returns desktop for wide screens", () => {
    expect(resolveUiDensityMode(1280)).toBe("desktop");
  });
});
