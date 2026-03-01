export type MobileTabId = "voice" | "actions" | "apps" | "timeline";

export type DesktopTabId = Exclude<MobileTabId, "voice">;

export type UiDensityMode = "mobile" | "tablet" | "desktop";
