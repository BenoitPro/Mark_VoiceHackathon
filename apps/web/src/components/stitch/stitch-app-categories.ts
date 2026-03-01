export type StitchAppCategoryId = "email" | "messaging" | "productivity" | "other";

const EMAIL_SLUGS = new Set(["gmail", "outlook", "yahoo"]);
const MESSAGING_SLUGS = new Set(["slack", "linkedin", "instagram"]);
const PRODUCTIVITY_SLUGS = new Set(["jira", "confluence", "notion"]);

export const STITCH_CATEGORY_LABELS: Record<StitchAppCategoryId, string> = {
  email: "Email Platforms",
  messaging: "Messaging Apps",
  productivity: "Productivity Tools",
  other: "Other Integrations"
};

export const STITCH_CATEGORY_ORDER: StitchAppCategoryId[] = ["email", "messaging", "productivity", "other"];

export function categorizeAppSlug(slug: string): StitchAppCategoryId {
  const normalized = slug.trim().toLowerCase();
  if (EMAIL_SLUGS.has(normalized)) {
    return "email";
  }
  if (MESSAGING_SLUGS.has(normalized)) {
    return "messaging";
  }
  if (PRODUCTIVITY_SLUGS.has(normalized)) {
    return "productivity";
  }
  return "other";
}
