const { OxagenLogo, Avatar, Badge } = window.OxagenDesignSystem_2dfe15;

const NAV = [
  { id: "ask", label: "Ask", icon: "message-square", group: "primary" },
  { id: "knowledge", label: "Knowledge", icon: "book-open", group: "primary" },
  { id: "automation", label: "Automation", icon: "workflow", group: "primary" },
  { id: "activity", label: "Activity", icon: "activity", group: "primary" },
  { id: "studio", label: "Studio", icon: "sparkles", group: "tools" },
  { id: "access", label: "Access", icon: "key-round", group: "tools" },
];

function NavItem({ item, active, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "8px 10px", borderRadius: "var(--radius-md)", border: "none",
        cursor: "pointer", textAlign: "left",
        fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: active ? 600 : 500,
        color: active ? "var(--foreground)" : hover ? "var(--foreground)" : "var(--muted-foreground)",
        background: active ? "var(--sidebar-accent)" : hover ? "color-mix(in oklch, var(--sidebar-accent) 60%, transparent)" : "transparent",
        position: "relative",
        transition: "background var(--motion-micro), color var(--motion-micro)",
      }}
    >
      {active && <span style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 3, background: "var(--grad-sunset)" }} />}
      <span style={{ color: active ? "var(--ox-violet-bright)" : "inherit" }}><Icon name={item.icon} size={17} /></span>
      {item.label}
    </button>
  );
}

function GroupLabel({ children }) {
  return <div style={{ padding: "2px 12px 6px", fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted-foreground)" }}>{children}</div>;
}

function Shell({ active, onNavigate, title, subtitle, tabs, children, theme, onToggleTheme }) {
  const primary = NAV.filter((n) => n.group === "primary");
  const tools = NAV.filter((n) => n.group === "tools");
  return (
    <div style={{ display: "flex", height: "100%", padding: 12, gap: 12, background: "var(--background)", boxSizing: "border-box" }}>
      {/* Sidebar */}
      <aside style={{ width: 232, flexShrink: 0, display: "flex", flexDirection: "column", background: "var(--sidebar)", border: "1px solid var(--sidebar-border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-md)", overflow: "hidden" }}>
        <div style={{ height: 56, display: "flex", alignItems: "center", padding: "0 14px" }}>
          <OxagenLogo variant="horizontal" size={22} />
        </div>
        <div style={{ flex: 1, padding: 8, display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
          <GroupLabel>Workspace</GroupLabel>
          {primary.map((n) => <NavItem key={n.id} item={n} active={active === n.id} onClick={() => onNavigate(n.id)} />)}
          <div style={{ height: 1, background: "var(--sidebar-border)", margin: "8px 10px" }} />
          <GroupLabel>Tools</GroupLabel>
          {tools.map((n) => <NavItem key={n.id} item={n} active={active === n.id} onClick={() => onNavigate(n.id)} />)}
        </div>
        <div style={{ padding: 8, borderTop: "1px solid var(--sidebar-border)", display: "flex", flexDirection: "column", gap: 4 }}>
          <NavItem item={{ id: "settings", label: "Settings", icon: "settings" }} active={active === "settings"} onClick={() => onNavigate("settings")} />
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: "var(--radius-md)" }}>
            <Avatar name="Mac Anderson" size={28} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--foreground)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Mac Anderson</div>
              <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>Owner</div>
            </div>
            <span style={{ marginLeft: "auto", color: "var(--muted-foreground)" }}><Icon name="chevrons-up-down" size={14} /></span>
          </div>
        </div>
      </aside>

      {/* Content panel */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--background-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden" }}>
        <header style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", gap: 12, padding: "0 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted-foreground)", fontSize: 13 }}>
            <Icon name="layout-grid" size={15} />
            <span>acme</span>
            <span style={{ opacity: 0.5 }}>/</span>
            <span style={{ color: "var(--foreground)", fontWeight: 500 }}>engineering</span>
            <span style={{ color: "var(--muted-foreground)" }}><Icon name="chevron-down" size={14} /></span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: "var(--radius-full)", border: "1px solid var(--border)", background: "var(--card)", fontFamily: "var(--font-sans)", fontWeight: 500, fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--foreground)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#67d182", boxShadow: "0 0 6px #67d182" }} />
              $248.10
            </span>
            <button onClick={onToggleTheme} aria-label="Toggle theme" style={{ display: "inline-flex", width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)", color: "var(--muted-foreground)", cursor: "pointer" }}><Icon name={theme === "light" ? "moon" : "sun"} size={16} /></button>
            <span style={{ color: "var(--muted-foreground)", cursor: "pointer" }}><Icon name="bell" size={17} /></span>
          </div>
        </header>
        {(title || tabs) && (
          <div style={{ padding: tabs ? "20px 24px 0" : "20px 24px", flexShrink: 0 }}>
            {title && <h1 style={{ fontFamily: "var(--font-sans)", fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>{title}</h1>}
            {subtitle && <p style={{ margin: "5px 0 0", color: "var(--muted-foreground)", fontSize: 13.5 }}>{subtitle}</p>}
            {tabs && <div style={{ marginTop: 16 }}>{tabs}</div>}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {children}
        </div>
      </main>
    </div>
  );
}

window.Shell = Shell;
