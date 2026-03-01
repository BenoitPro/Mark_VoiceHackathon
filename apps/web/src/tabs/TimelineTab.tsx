export type TimelineViewItem = {
  id: string;
  type: string;
  message: string;
  createdAt: string;
};

type TimelineTabProps = {
  sourceLabel: string;
  items: TimelineViewItem[];
};

export default function TimelineTab({ sourceLabel, items }: TimelineTabProps) {
  return (
    <section className="tab-flow" aria-label="Timeline">
      <article className="card">
        <header className="card-head">
          <h2>Action Timeline</h2>
          <p className="compact-text muted">{sourceLabel}</p>
        </header>

        {items.length === 0 ? (
          <p className="compact-text muted">No action events yet.</p>
        ) : (
          <div className="list stack-sm">
            {items.map((item) => (
              <article className="timeline-item" key={item.id}>
                <p className="timeline-type">{item.type}</p>
                <p>{item.message}</p>
                <time>{new Date(item.createdAt).toLocaleString()}</time>
              </article>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}
