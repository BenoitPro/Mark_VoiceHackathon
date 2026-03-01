const LOGOS_BY_SLUG: Record<string, string> = {
  gmail: "https://cdn.simpleicons.org/gmail/EA4335",
  outlook: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/microsoftoutlook.svg",
  yahoo: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/yahoo.svg",
  slack: "https://cdn.simpleicons.org/slack/4A154B",
  linkedin: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/linkedin.svg",
  instagram: "https://cdn.simpleicons.org/instagram/E4405F",
  jira: "https://cdn.simpleicons.org/jira/0B66E4",
  confluence: "https://cdn.simpleicons.org/confluence/0052CC",
  notion: "https://cdn.simpleicons.org/notion/111111"
};
const GENERIC_LOGO_URL = "https://cdn.simpleicons.org/appstore/7A8CA9";

type StitchAppLogoProps = {
  slug: string;
  alt?: string;
  className?: string;
};

export function StitchAppLogo({ slug, alt, className }: StitchAppLogoProps) {
  const normalized = normalizeSlug(slug);
  const label = alt ?? `${normalized || "app"} logo`;

  return <img className={className} src={resolveAppLogo(slug)} alt={label} loading="lazy" decoding="async" />;
}

export function resolveAppLogo(slug: string): string {
  const normalized = normalizeSlug(slug);
  if (!normalized) {
    return GENERIC_LOGO_URL;
  }
  return LOGOS_BY_SLUG[normalized] ?? GENERIC_LOGO_URL;
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}
