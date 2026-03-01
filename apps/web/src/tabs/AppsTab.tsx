export type CatalogListItem = {
  authConfigId: string;
  toolkitName: string;
  name: string;
  authScheme: string | null;
  statusLabel: string;
  isActive: boolean;
};

type AppsTabProps = {
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  items: CatalogListItem[];
  connectingAuthConfigId: string | null;
  onConnect: (authConfigId: string) => void;
};

export default function AppsTab({
  loading,
  search,
  onSearchChange,
  items,
  connectingAuthConfigId,
  onConnect
}: AppsTabProps) {
  return (
    <section className="tab-flow" aria-label="Apps">
      <article className="card stack-md">
        <header className="card-head">
          <h2>Connect Apps</h2>
          <p className="compact-text muted">{items.length} visible</p>
        </header>
        <label htmlFor="catalog-search" className="compact-text muted">
          Search app or toolkit
        </label>
        <input
          id="catalog-search"
          className="input"
          placeholder="Search by app or toolkit"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </article>

      <article className="card">
        {loading ? <p className="compact-text muted">Loading catalog...</p> : null}
        {!loading && items.length === 0 ? <p className="compact-text muted">No matching apps.</p> : null}

        <div className="list stack-sm">
          {items.map((item) => {
            const isConnecting = connectingAuthConfigId === item.authConfigId;
            return (
              <article className="list-item" key={item.authConfigId}>
                <div className="stack-sm">
                  <p className="list-title">{item.toolkitName}</p>
                  <p className="compact-text muted">
                    {item.name} • {item.authScheme ?? "oauth"}
                  </p>
                  <span className={`pill ${item.isActive ? "pill-ok" : "pill-warn"}`}>{item.statusLabel}</span>
                </div>
                <button className="btn" onClick={() => onConnect(item.authConfigId)} disabled={isConnecting}>
                  {isConnecting ? "Connecting..." : "Connect"}
                </button>
              </article>
            );
          })}
        </div>
      </article>
    </section>
  );
}
