import { describe, expect, it } from "vitest";

import { buildApiUrl, buildSocketNamespaceUrl } from "./apiBaseUrl";

describe("apiBaseUrl", () => {
  it("builds REST URLs without duplicate slashes", () => {
    expect(buildApiUrl("http://localhost:4000/", "/health")).toBe("http://localhost:4000/health");
    expect(buildApiUrl("http://localhost:4000", "health")).toBe("http://localhost:4000/health");
  });

  it("builds Socket namespace URLs without duplicate slashes", () => {
    expect(buildSocketNamespaceUrl("http://localhost:4000/", "/v1/session")).toBe(
      "http://localhost:4000/v1/session"
    );
    expect(buildSocketNamespaceUrl("http://localhost:4000", "v1/session")).toBe("http://localhost:4000/v1/session");
  });
});
