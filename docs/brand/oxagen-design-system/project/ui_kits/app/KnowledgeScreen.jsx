const { Button, Badge, Tabs, NodeChip, ConfidenceBar } = window.OxagenDesignSystem_2dfe15;

const KIND_COLOR = {
  user: "#45dcef", document: "#9b7bff", service: "#67d182", policy: "#ea5a82", resource: "#ffbe63",
};

const NODES = [
  { id: "u1", x: 150, y: 110, r: 13, kind: "user", label: "Ada L." },
  { id: "d1", x: 300, y: 60, r: 11, kind: "document", label: "Auth spec" },
  { id: "d2", x: 320, y: 175, r: 11, kind: "document", label: "RLS policy" },
  { id: "s1", x: 110, y: 240, r: 12, kind: "service", label: "GitHub" },
  { id: "p1", x: 250, y: 285, r: 10, kind: "policy", label: "read:eng" },
  { id: "d3", x: 450, y: 120, r: 10, kind: "document", label: "OXA-1515" },
  { id: "r1", x: 470, y: 250, r: 10, kind: "resource", label: "vault" },
  { id: "u2", x: 60, y: 130, r: 10, kind: "user", label: "Grace H." },
];
const EDGES = [
  ["u1", "d1"], ["u1", "d2"], ["u1", "s1"], ["d2", "p1"], ["d1", "d3"],
  ["d2", "d3"], ["s1", "p1"], ["d3", "r1"], ["d2", "r1"], ["u2", "u1"], ["u2", "s1"],
];

function GraphCanvas() {
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  return (
    <div className="ox-grid-dots" style={{ position: "relative", flex: 1, minWidth: 0, borderRadius: "var(--radius-lg)", border: "1px solid var(--border)", background: "var(--background)", overflow: "hidden", minHeight: 360 }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 60% at 40% 30%, color-mix(in oklch, var(--violet-600) 18%, transparent), transparent 70%)" }} />
      <svg viewBox="0 0 540 360" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <defs>
          <linearGradient id="edgeg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#45dcef" stopOpacity="0.5" />
            <stop offset="1" stopColor="#9b7bff" stopOpacity="0.5" />
          </linearGradient>
        </defs>
        {EDGES.map(([a, b], i) => (
          <line key={i} x1={byId[a].x} y1={byId[a].y} x2={byId[b].x} y2={byId[b].y} stroke="url(#edgeg)" strokeWidth="1.2" />
        ))}
        {NODES.map((n) => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={n.r + 9} fill={KIND_COLOR[n.kind]} opacity="0.16" />
            <circle cx={n.x} cy={n.y} r={n.r} fill={KIND_COLOR[n.kind]} stroke="var(--background)" strokeWidth="2" />
            <text x={n.x} y={n.y + n.r + 14} textAnchor="middle" fontFamily="var(--font-sans)" fontSize="9.5" fill="var(--muted-foreground)">{n.label}</text>
          </g>
        ))}
      </svg>
      <div style={{ position: "absolute", left: 14, top: 14, display: "flex", gap: 7, flexWrap: "wrap" }}>
        {Object.entries(KIND_COLOR).map(([k, c]) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 500, color: "var(--muted-foreground)", background: "color-mix(in oklch, var(--background) 70%, transparent)", padding: "2px 7px", borderRadius: 999, border: "1px solid var(--border)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: c }} />{k}
          </span>
        ))}
      </div>
      <div style={{ position: "absolute", right: 14, bottom: 14, display: "flex", gap: 6 }}>
        <button style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon name="plus" size={15} /></button>
        <button style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon name="minus" size={15} /></button>
        <button style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon name="maximize" size={14} /></button>
      </div>
    </div>
  );
}

function Stat({ value, label, accent }) {
  return (
    <div style={{ flex: 1, padding: "12px 14px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}>
      <div style={{ fontFamily: "var(--font-sans)", fontSize: 22, fontWeight: 700, color: accent || "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted-foreground)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function PendingEdge({ rel, from, to, fromKind, toKind, score, connector }) {
  const [resolved, setResolved] = React.useState(null);
  return (
    <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--background-2)", opacity: resolved ? 0.5 : 1, transition: "opacity var(--motion-base)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 8 }}>
        <NodeChip kind={fromKind} id={from} />
        <span style={{ color: "var(--muted-foreground)" }}><Icon name="arrow-right" size={13} /></span>
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ox-violet-bright)", background: "color-mix(in oklch, var(--violet-500) 16%, transparent)", borderRadius: 4, padding: "2px 6px" }}>{rel}</code>
        <span style={{ color: "var(--muted-foreground)" }}><Icon name="arrow-right" size={13} /></span>
        <NodeChip kind={toKind} id={to} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ConfidenceBar score={score} width={90} />
        <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted-foreground)" }}>via {connector}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {resolved ? (
            <Badge variant={resolved === "approved" ? "success" : "neutral"} dot>{resolved}</Badge>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setResolved("denied")}>Deny</Button>
              <Button size="sm" variant="primary" onClick={() => setResolved("approved")} startIcon={<Icon name="check" size={14} color="#fff" />}>Approve</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function KnowledgeScreen() {
  const [tab, setTab] = React.useState("graph");
  return (
    <div style={{ padding: "0 24px 24px" }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <Stat value="18.2k" label="Edges" accent="var(--cyan-300)" />
        <Stat value="4.1k" label="Nodes" />
        <Stat value="6" label="Sources" />
        <Stat value="23" label="Pending" accent="#ffbe63" />
      </div>
      <div style={{ display: "flex", gap: 18, alignItems: "stretch", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 340px", display: "flex", flexDirection: "column", minWidth: 320 }}>
          <GraphCanvas />
        </div>
        <div style={{ flex: "1 1 320px", minWidth: 300, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--ox-violet-bright)" }}><Icon name="git-pull-request-arrow" size={16} /></span>
            <h3 style={{ fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600, margin: 0 }}>Pending inferences</h3>
            <Badge variant="warning" style={{ marginLeft: "auto" }}>23 to review</Badge>
          </div>
          <PendingEdge rel="CAN_READ" from="prn_8fa21c" to="doc_41be09" fromKind="user" toKind="document" score={0.92} connector="github" />
          <PendingEdge rel="OWNS" from="svc_github" to="doc_9c2a1f" fromKind="service" toKind="document" score={0.74} connector="github" />
          <PendingEdge rel="GOVERNS" from="pol_read_eng" to="doc_77fd03" fromKind="policy" toKind="document" score={0.58} connector="okta" />
        </div>
      </div>
    </div>
  );
}

window.KnowledgeScreen = KnowledgeScreen;
window.KnowledgeTabs = function ({ tab, setTab }) {
  return <Tabs value={tab} onChange={setTab} items={[
    { value: "sources", label: "Sources", icon: <Icon name="plug" size={14} />, badge: 6 },
    { value: "graph", label: "Graph", icon: <Icon name="git-fork" size={14} /> },
    { value: "memories", label: "Memories", icon: <Icon name="brain" size={14} />, badge: 12 },
  ]} />;
};
