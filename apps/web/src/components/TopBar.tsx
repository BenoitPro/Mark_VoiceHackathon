import type { Session } from "@supabase/supabase-js";

type TopBarProps = {
  session: Session | null;
  userEmail: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
};

export function TopBar({ session, userEmail, onSignIn, onSignOut }: TopBarProps) {
  return (
    <header className="topbar card" role="banner">
      <div>
        <p className="eyebrow">Mark Agent</p>
        <h1>Voice Action Runtime</h1>
      </div>

      {session ? (
        <div className="topbar-actions">
          <span className="status-badge" title={userEmail ?? "Authenticated"}>
            {userEmail ?? "Signed in"}
          </span>
          <details className="overflow-menu">
            <summary className="btn btn-ghost" aria-label="Open account menu">
              Menu
            </summary>
            <div className="menu-panel">
              <button className="btn" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </details>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={onSignIn}>
          Sign In With Google
        </button>
      )}
    </header>
  );
}
