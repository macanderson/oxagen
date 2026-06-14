function App() {
  const [authed, setAuthed] = React.useState(false);
  const [active, setActive] = React.useState("ask");
  const [kTab, setKTab] = React.useState("graph");
  const [theme, setTheme] = React.useState("dark");
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  function frame(children) {
    return <div className={theme === "light" ? "light" : ""} style={{ height: "100%" }}>{children}</div>;
  }

  if (!authed) return frame(<window.LoginScreen onAuth={() => setAuthed(true)} theme={theme} onToggleTheme={toggleTheme} />);

  let title, subtitle, tabs, body;
  if (active === "ask") {
    body = <window.AskScreen />;
  } else if (active === "knowledge") {
    title = "Knowledge";
    subtitle = "Typed entities and permission-checked relationships across your sources.";
    tabs = <window.KnowledgeTabs tab={kTab} setTab={setKTab} />;
    body = <window.KnowledgeScreen />;
  } else if (active === "access") {
    title = "Access";
    subtitle = "Roles and policies that scope what every principal — human or agent — can reach.";
    body = <window.AccessScreen />;
  } else {
    title = active.charAt(0).toUpperCase() + active.slice(1);
    subtitle = "This surface is part of the Oxagen kit — explore Ask, Knowledge and Access for the full build-out.";
    body = (
      <div style={{ display: "grid", placeItems: "center", height: "100%", padding: 40, textAlign: "center" }}>
        <div>
          <span style={{ color: "var(--muted-foreground)" }}><Icon name="construction" size={28} /></span>
          <p style={{ color: "var(--muted-foreground)", fontSize: 13, marginTop: 10 }}>{title} — wired in the full product.</p>
        </div>
      </div>
    );
  }

  // Ask is full-bleed (its own header-less chat layout)
  if (active === "ask") {
    return frame(<window.Shell active={active} onNavigate={setActive} theme={theme} onToggleTheme={toggleTheme}>{body}</window.Shell>);
  }
  return frame(
    <window.Shell active={active} onNavigate={setActive} title={title} subtitle={subtitle} tabs={tabs} theme={theme} onToggleTheme={toggleTheme}>
      {body}
    </window.Shell>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
// Convert any lucide placeholders rendered before the font script settled.
setTimeout(() => { try { window.lucide && window.lucide.createIcons(); } catch (e) {} }, 300);
