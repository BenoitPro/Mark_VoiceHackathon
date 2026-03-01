import type { MobileTabId } from "../uiTypes";

type BottomNavProps = {
  activeTab: MobileTabId;
  onSelectTab: (tab: MobileTabId) => void;
};

const TABS: Array<{ id: MobileTabId; label: string }> = [
  { id: "voice", label: "Voice" },
  { id: "actions", label: "Actions" },
  { id: "apps", label: "Apps" },
  { id: "timeline", label: "Timeline" }
];

export function BottomNav({ activeTab, onSelectTab }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            className={`bottom-nav-item ${isActive ? "is-active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
