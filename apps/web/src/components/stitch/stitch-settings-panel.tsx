import { categorizeAppSlug, STITCH_CATEGORY_LABELS, STITCH_CATEGORY_ORDER, type StitchAppCategoryId } from "./stitch-app-categories";
import { StitchAppLogo } from "./stitch-app-logo";

type StitchIntegrationItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: "connected" | "available";
};

const SAMPLE_INTEGRATIONS: StitchIntegrationItem[] = [
  { id: "gmail", slug: "gmail", name: "Gmail", description: "mark@enterprise.com", status: "connected" },
  { id: "outlook", slug: "outlook", name: "Outlook", description: "Sync calendar & contacts", status: "available" },
  { id: "slack", slug: "slack", name: "Slack", description: "Enterprise workspace", status: "connected" },
  { id: "linkedin", slug: "linkedin", name: "LinkedIn", description: "Sales Navigator sync", status: "available" },
  { id: "jira", slug: "jira", name: "Jira", description: "Issue tracking", status: "connected" },
  { id: "confluence", slug: "confluence", name: "Confluence", description: "Knowledge base", status: "available" }
];

export function StitchSettingsPanel() {
  const grouped = groupByCategory(SAMPLE_INTEGRATIONS);

  return (
    <section className="stitch-root stitch-settings-shell" aria-label="Stitch settings preview">
      <header className="stitch-settings-header">
        <button className="stitch-icon-btn" type="button" aria-label="Close settings">
          <span aria-hidden>×</span>
        </button>
        <h2>Integrations</h2>
        <button className="stitch-text-btn" type="button">
          Done
        </button>
      </header>

      <div className="stitch-settings-scroll">
        {STITCH_CATEGORY_ORDER.filter((id) => grouped[id].length > 0).map((categoryId, index) => (
          <details key={categoryId} className="stitch-accordion" open={index === 0}>
            <summary>
              <span>{STITCH_CATEGORY_LABELS[categoryId]}</span>
              <span aria-hidden>▾</span>
            </summary>

            <div className="stitch-accordion-content">
              {grouped[categoryId].map((item) => {
                const connected = item.status === "connected";
                return (
                  <article key={item.id} className="stitch-integration-row">
                    <StitchAppLogo slug={item.slug} className="stitch-app-logo" alt={`${item.name} logo`} />
                    <div className="stitch-card-body">
                      <p className="stitch-card-title">{item.name}</p>
                      <p className="stitch-card-subtitle">{item.description}</p>
                    </div>
                    <button type="button" className={`stitch-mini-btn ${connected ? "is-neutral" : "is-primary"}`}>
                      {connected ? "Disconnect" : "Connect"}
                    </button>
                  </article>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function groupByCategory(items: StitchIntegrationItem[]): Record<StitchAppCategoryId, StitchIntegrationItem[]> {
  const groups: Record<StitchAppCategoryId, StitchIntegrationItem[]> = {
    email: [],
    messaging: [],
    productivity: [],
    other: []
  };

  for (const item of items) {
    groups[categorizeAppSlug(item.slug)].push(item);
  }

  return groups;
}
