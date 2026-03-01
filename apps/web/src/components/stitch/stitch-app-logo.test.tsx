import { describe, expect, it } from "vitest";

import { resolveAppLogo } from "./stitch-app-logo";

describe("resolveAppLogo", () => {
  it("returns Gmail logo for gmail slug", () => {
    expect(resolveAppLogo("gmail")).toBe("https://cdn.simpleicons.org/gmail/EA4335");
  });

  it("returns working remote logo for LinkedIn slug", () => {
    expect(resolveAppLogo("linkedin")).toBe("https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/linkedin.svg");
  });

  it("returns working remote logo for Outlook slug", () => {
    expect(resolveAppLogo("outlook")).toBe("https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/microsoftoutlook.svg");
  });

  it("returns working remote logo for Yahoo slug", () => {
    expect(resolveAppLogo("yahoo")).toBe("https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/yahoo.svg");
  });

  it("returns generic logo for unknown slug", () => {
    expect(resolveAppLogo("unknown-tool")).toBe("https://cdn.simpleicons.org/appstore/7A8CA9");
  });
});
