const { Button, Input, OxagenLogo } = window.OxagenDesignSystem_2dfe15;

function OAuthBtn({ icon, label }) {
  return (
    <button style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, width: "100%", height: 40, borderRadius: "var(--radius-md)", border: "1px solid var(--border-strong)", background: "var(--background-2)", color: "var(--foreground)", fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
      <Icon name={icon} size={16} /> {label}
    </button>
  );
}

function LoginScreen({ onAuth, theme, onToggleTheme }) {
  return (
    <div className="ox-mesh" style={{ position: "relative", height: "100%", display: "grid", placeItems: "center", padding: 24, boxSizing: "border-box" }}>
      <button onClick={onToggleTheme} aria-label="Toggle theme" style={{ position: "absolute", top: 18, right: 18, width: 34, height: 34, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)", color: "var(--muted-foreground)", cursor: "pointer" }}><Icon name={theme === "light" ? "moon" : "sun"} size={16} /></button>
      <div style={{ position: "relative", width: "100%", maxWidth: 380 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 22 }}>
          <OxagenLogo variant="vertical" size={40} />
        </div>
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", padding: 26, boxShadow: "var(--shadow-xl)" }}>
          <h1 style={{ fontFamily: "var(--font-sans)", fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", margin: 0, textAlign: "center" }}>Welcome back</h1>
          <p style={{ margin: "6px 0 20px", textAlign: "center", fontSize: 13, color: "var(--muted-foreground)" }}>Sign in to your Oxagen workspace.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <OAuthBtn icon="github" label="Continue with GitHub" />
            <OAuthBtn icon="chrome" label="Continue with Google" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0" }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span style={{ fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted-foreground)" }}>Or</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 5 }}>Email</label>
              <Input defaultValue="mac@acme.dev" startIcon={<Icon name="mail" size={14} />} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 5 }}>Password</label>
              <Input type="password" defaultValue="hunter2hunter2" startIcon={<Icon name="lock" size={14} />} />
            </div>
            <Button variant="gradient" size="lg" onClick={onAuth} style={{ width: "100%", marginTop: 4 }}>Sign in</Button>
          </div>
          <p style={{ margin: "16px 0 0", textAlign: "center", fontSize: 12.5, color: "var(--muted-foreground)" }}>
            Don't have an account? <span style={{ color: "var(--ox-violet-bright)", cursor: "pointer", fontWeight: 500 }}>Sign up</span>
          </p>
        </div>
        <p style={{ textAlign: "center", marginTop: 16, fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted-foreground)", letterSpacing: "0.02em" }}>
          SOC 2 Type II · SSO/SCIM · RBAC-enforced retrieval
        </p>
      </div>
    </div>
  );
}

window.LoginScreen = LoginScreen;
