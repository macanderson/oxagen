const { Badge, Button } = window.OxagenDesignSystem_2dfe15;

const ROLES = [
  { name: "Owner", icon: "crown", color: "#ffbe63", members: 1, desc: "Full control. Billing, members, security, and every setting.",
    perms: [["Manage members", "full"], ["Manage billing", "full"], ["Configure security", "full"], ["Run agents", "full"], ["Delete org", "full"]] },
  { name: "Admin", icon: "shield-check", color: "#45dcef", members: 2, desc: "Invite members, manage workspaces, most org settings. No billing.",
    perms: [["Manage members", "full"], ["Manage billing", "none"], ["Configure security", "limited"], ["Run agents", "full"], ["Delete org", "none"]] },
  { name: "Billing", icon: "credit-card", color: "#67d182", members: 1, desc: "Read/write billing, subscriptions, usage. No members or security.",
    perms: [["Manage members", "none"], ["Manage billing", "full"], ["Configure security", "none"], ["Run agents", "limited"], ["Delete org", "none"]] },
  { name: "Member", icon: "users", color: "#9b7bff", members: 4, desc: "Standard access. Use agents and contribute to assigned workspaces.",
    perms: [["Manage members", "none"], ["Manage billing", "none"], ["Configure security", "none"], ["Run agents", "full"], ["Delete org", "none"]] },
  { name: "Viewer", icon: "eye", color: "var(--muted-foreground)", members: 2, desc: "Read-only across workspaces and knowledge. Cannot run agents.",
    perms: [["Manage members", "none"], ["Manage billing", "none"], ["Configure security", "none"], ["Run agents", "none"], ["Delete org", "none"]] },
  { name: "Custom", icon: "plus", color: "var(--ox-violet-bright)", members: 0, desc: "Compose a role from scoped permissions across the graph.", custom: true, perms: [] },
];

function PermRow({ label, state }) {
  const icon = state === "full" ? ["check", "#67d182"] : state === "limited" ? ["minus", "#ffbe63"] : ["minus", "var(--muted-foreground)"];
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", fontSize: 12, borderTop: "1px solid color-mix(in oklch, var(--border) 60%, transparent)" }}>
      <span style={{ color: "var(--muted-foreground)" }}>{label}</span>
      <span style={{ color: icon[1], opacity: state === "none" ? 0.4 : 1 }}><Icon name={icon[0]} size={14} /></span>
    </div>
  );
}

function RoleCard({ role }) {
  if (role.custom) {
    return (
      <div className="ox-gradient-ring" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20, borderRadius: "var(--radius-lg)", background: "var(--card)", minHeight: 220, textAlign: "center" }}>
        <span style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--violet-500) 16%, transparent)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--ox-violet-bright)" }}><Icon name="plus" size={20} /></span>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600 }}>New custom role</div>
        <div style={{ fontSize: 12, color: "var(--muted-foreground)", maxWidth: 200 }}>{role.desc}</div>
        <Button variant="outline" size="sm" style={{ marginTop: 4 }}>Create role</Button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, borderRadius: "var(--radius-lg)", background: "var(--card)", border: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--background-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: role.color }}><Icon name={role.icon} size={17} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600 }}>{role.name}</div>
          <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{role.members} {role.members === 1 ? "member" : "members"}</div>
        </div>
        <Badge variant="neutral" mono><Icon name="lock" size={10} style={{ marginRight: 3 }} />System</Badge>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--muted-foreground)" }}>{role.desc}</div>
      <div>{role.perms.map((p) => <PermRow key={p[0]} label={p[0]} state={p[1]} />)}</div>
    </div>
  );
}

function AccessScreen() {
  return (
    <div style={{ padding: "0 24px 24px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
        {ROLES.map((r) => <RoleCard key={r.name} role={r} />)}
      </div>
    </div>
  );
}

window.AccessScreen = AccessScreen;
