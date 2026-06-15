const { Button, Badge, Textarea, NodeChip } = window.OxagenDesignSystem_2dfe15;
const FM = (typeof window !== "undefined" && window.Motion) || null;
const MDiv = FM ? FM.motion.div : "div";

function Bubble({ role, children, animate = true }) {
  const isUser = role === "user";
  const motionProps = FM && animate
    ? { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { type: "spring", stiffness: 380, damping: 30 } }
    : {};
  return (
    <MDiv {...motionProps} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div style={{
        maxWidth: "82%",
        padding: isUser ? "10px 14px" : "12px 16px",
        borderRadius: isUser ? "16px 16px 4px 16px" : "var(--radius-lg)",
        fontSize: 13.5, lineHeight: 1.6,
        background: isUser ? "var(--accent)" : "var(--card)",
        color: isUser ? "var(--accent-foreground)" : "var(--card-foreground)",
        border: isUser ? "1px solid var(--border)" : "1px solid var(--border)",
        boxShadow: "var(--shadow-sm)",
      }}>
        {children}
      </div>
    </MDiv>
  );
}

function Thinking() {
  const dot = (d) => ({ width: 6, height: 6, borderRadius: "50%", background: "var(--ox-violet-bright)" });
  const anim = FM ? { animate: { opacity: [0.3, 1, 0.3], y: [0, -2, 0] } } : {};
  return (
    <Bubble role="assistant" animate={false}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "flex", gap: 4 }}>
          {[0, 1, 2].map((i) => (
            <MDiv key={i} {...(FM ? { animate: { opacity: [0.3, 1, 0.3], y: [0, -2, 0] }, transition: { duration: 0.9, repeat: Infinity, delay: i * 0.15 } } : {})} style={dot()} />
          ))}
        </span>
        <span style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>Scoping retrieval to your grants…</span>
      </div>
    </Bubble>
  );
}

function TimelineItem({ tone = "done", icon, children }) {
  const dot = tone === "running" ? "var(--ox-violet-bright)" : tone === "failed" ? "var(--destructive)" : "var(--cyan-400)";
  return (
    <div style={{ display: "flex", gap: 12, position: "relative" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--background-2)", border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: dot }}>
          <Icon name={icon} size={13} />
        </span>
        <span style={{ flex: 1, width: 1, background: "var(--border)", marginTop: 2, minHeight: 8 }} />
      </div>
      <div style={{ flex: 1, paddingBottom: 14 }}>{children}</div>
    </div>
  );
}

function ToolCard() {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--background-2)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--cyan-400)" }}><Icon name="database" size={15} /></span>
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: "var(--foreground)" }}>graph.query</code>
        <Badge variant="risk-low" style={{ marginLeft: 4 }}>low risk</Badge>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted-foreground)" }}>318ms</span>
        <span style={{ color: "#67d182" }}><Icon name="check" size={15} /></span>
      </div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--muted-foreground)", lineHeight: 1.5 }}>
          MATCH (u:User)-[:CAN_READ]-&gt;(d:Document) WHERE u.id = "prn_8fa21c"
        </code>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <NodeChip kind="document" label="Auth spec" id="doc_41be" />
          <NodeChip kind="document" label="RLS policy" id="doc_9c2a" />
          <NodeChip kind="document" label="OXA-1515" id="doc_77fd" />
        </div>
      </div>
    </div>
  );
}

function Thread({ messages, thinking }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 760, margin: "0 auto", padding: "20px 24px 8px" }}>
      {messages.map((m, i) => (
        m.role === "user" ? (
          <Bubble key={i} role="user">{m.text}</Bubble>
        ) : (
          <Bubble key={i} role="assistant">
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--grad-cosmos)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="sparkles" size={11} color="#fff" />
              </span>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Oxagen agent</span>
              <Badge variant="neutral" mono style={{ marginLeft: 2 }}>claude-sonnet</Badge>
            </div>
            {m.reasoning && (
              <TimelineItem tone="done" icon="brain">
                <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>Thought for 4s · scoped retrieval to caller's read grants</div>
              </TimelineItem>
            )}
            {m.tool && <TimelineItem tone="done" icon="wrench"><ToolCard /></TimelineItem>}
            <div style={{ paddingLeft: m.tool || m.reasoning ? 36 : 0 }}>{m.text}</div>
          </Bubble>
        )
      ))}
      {thinking && <Thinking />}
    </div>
  );
}

function Composer({ onSend }) {
  const [val, setVal] = React.useState("");
  const [gen, setGen] = React.useState(null);
  function submit() {
    if (!val.trim()) return;
    onSend(val.trim());
    setVal("");
  }
  const toolBtn = (name, key, label) => {
    const on = gen === key;
    return (
      <button onClick={() => setGen(on ? null : key)} title={label} style={{
        width: 32, height: 32, borderRadius: "var(--radius-md)", border: "1px solid transparent",
        background: on ? "color-mix(in oklch, var(--primary) 18%, transparent)" : "transparent",
        color: on ? "var(--ox-violet-bright)" : "var(--muted-foreground)", cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}><Icon name={name} size={16} /></button>
    );
  };
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", width: "100%", padding: "8px 24px 20px", boxSizing: "border-box" }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", padding: 12, boxShadow: "var(--shadow-md)" }}>
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          placeholder="Ask anything — the agent only sees what you're allowed to…"
          rows={2}
          style={{ width: "100%", border: "none", outline: "none", resize: "none", background: "transparent", color: "var(--foreground)", fontFamily: "var(--font-sans)", fontSize: 13.5, lineHeight: 1.55, padding: "2px 4px" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
          <button style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--background-2)", color: "var(--foreground)", fontSize: 12.5, fontWeight: 500, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            <Icon name="zap" size={14} color="var(--ox-violet-bright)" /> Fast <Icon name="chevron-down" size={13} />
          </button>
          <button style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px", borderRadius: "var(--radius-md)", border: "1px solid transparent", background: "transparent", color: "var(--muted-foreground)", fontSize: 12.5, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            <Icon name="brain" size={14} /> Medium
          </button>
          {toolBtn("image", "image", "Generate image")}
          {toolBtn("video", "video", "Generate video")}
          <button style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px", borderRadius: "var(--radius-md)", border: "1px solid transparent", background: "transparent", color: "var(--muted-foreground)", fontSize: 12.5, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            <Icon name="plug" size={14} /> 3 MCP
          </button>
          <div style={{ marginLeft: "auto" }}>
            <Button variant="gradient" size="sm" onClick={submit} startIcon={<Icon name="arrow-up" size={15} color="#fff" />}>Send</Button>
          </div>
        </div>
      </div>
      <div style={{ textAlign: "center", marginTop: 8, fontSize: 11, color: "var(--muted-foreground)" }}>
        Retrieval is RBAC-enforced · ⌘↵ to send
      </div>
    </div>
  );
}

function AskScreen() {
  const scrollRef = React.useRef(null);
  const [messages, setMessages] = React.useState([
    { role: "user", text: "What does the auth service need to know about row-level security?" },
    { role: "assistant", reasoning: true, tool: true, text: (
      <div style={{ fontSize: 13.5, lineHeight: 1.65 }}>
        Row-level security (RLS) scopes every query to the caller's tenant. The auth service should set <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--muted)", padding: "1px 5px", borderRadius: 4 }}>app.tenant_id</code> before any read, and use <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--muted)", padding: "1px 5px", borderRadius: 4 }}>withSystemDb</code> only for pre-tenant identity resolution (see OXA-1515).
      </div>
    ) },
  ]);
  const [thinking, setThinking] = React.useState(false);
  function send(text) {
    setMessages((m) => [...m, { role: "user", text }]);
    setThinking(true);
    setTimeout(() => {
      setThinking(false);
      setMessages((m) => [...m, { role: "assistant", reasoning: true, tool: false, text: "Pulling scoped context from the graph — only nodes you can read are in view. Here's what I found across the connected sources." }]);
    }, 1100);
  }
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thinking]);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Thread messages={messages} thinking={thinking} />
      </div>
      <Composer onSend={send} />
    </div>
  );
}

window.AskScreen = AskScreen;
