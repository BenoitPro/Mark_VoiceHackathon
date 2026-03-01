import { StitchAppLogo } from "./stitch-app-logo";

type StitchActivityItem = {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  age: string;
  muted?: boolean;
};

const SAMPLE_ACTIVITY: StitchActivityItem[] = [
  {
    id: "a1",
    slug: "gmail",
    title: "Follow-up drafted",
    subtitle: "ACME Enterprise Agreement",
    age: "2m"
  },
  {
    id: "a2",
    slug: "slack",
    title: "Message from Sarah",
    subtitle: '"Review the Q4 projections before the..."',
    age: "15m"
  },
  {
    id: "a3",
    slug: "jira",
    title: "TechCorp Demo Prep",
    subtitle: "Notes generated 1h ago",
    age: "1h",
    muted: true
  }
];

export function StitchVoiceStage() {
  return (
    <section className="stitch-root stitch-phone-shell" aria-label="Stitch voice stage preview">
      <div className="stitch-ambient-fluid-border" aria-hidden />

      <header className="stitch-header">
        <button className="stitch-icon-btn" type="button" aria-label="Open settings">
          <span aria-hidden>⚙</span>
        </button>

        <button className="stitch-listening-pill is-listening" type="button" aria-label="Listening state">
          <span className="stitch-waveform" aria-hidden>
            <span className="stitch-wave-bar" />
            <span className="stitch-wave-bar" />
            <span className="stitch-wave-bar" />
            <span className="stitch-wave-bar" />
          </span>
          <span>Listening...</span>
        </button>
      </header>

      <div className="stitch-transcript">
        <p className="stitch-transcript-kicker">Live Transcript</p>
        <p className="stitch-transcript-line">
          "Draft a brief follow-up email to the engineering team about the Q4 sprint progress and next steps."
        </p>
      </div>

      <section className="stitch-activity" aria-label="Recent activity">
        <div className="stitch-activity-head">
          <h2>Recent Activity</h2>
          <button type="button" className="stitch-view-all">
            View all
          </button>
        </div>

        <div className="stitch-activity-list">
          {SAMPLE_ACTIVITY.map((item) => (
            <article key={item.id} className={`stitch-card ${item.muted ? "is-muted" : ""}`}>
              <StitchAppLogo slug={item.slug} className="stitch-app-logo" alt={`${item.slug} logo`} />
              <div className="stitch-card-body">
                <p className="stitch-card-title">{item.title}</p>
                <p className="stitch-card-subtitle">{item.subtitle}</p>
              </div>
              <time className="stitch-card-age">{item.age}</time>
            </article>
          ))}
        </div>
      </section>

      <div className="stitch-home-indicator" aria-hidden />
    </section>
  );
}
