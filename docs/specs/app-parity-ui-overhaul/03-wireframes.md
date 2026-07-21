# 03 — Wireframes (low-fidelity, line-drawn)

Line-drawn, structure-only. No color, no final copy. Every field maps to a real contract
field; annotations in `«…»` call out the binding. The golden path (Brand Voice skill →
audit agent → saved prompt → `/audit` command) runs through the examples so the screens
connect.

Legend: `◇` nav item · `[ Button ]` · `( ) / (•)` radio · `[x] / [ ]` checkbox ·
`▾` select · `«bind»` contract binding · `▸` expandable.

---

## 0. Global shell

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ OXAGEN       │  acme / research-ws ▾              ⌘K   ◔ usage $12.40   ◕ MA  │
│ ◇ Ask        ├──────────────────────────────────────────────────────────────┤
│ ◇ Runs       │                                                                │
│ ◇ Fleets     │                                                                │
│ ◇ Approvals⌈3⌉│                    « page content »                           │
│ ──Studio──   │                                                                │
│ ◇ Agents     │                                                                │
│ ◇ Skills     │                                                                │
│ ◇ Prompts    │                                                                │
│ ◇ Commands   │                                                                │
│ ◇ Tools      │                                                                │
│ ──Knowledge──│                                                                │
│ ◇ Graph      │                                                                │
│ ◇ Ontology   │                                                                │
│ ◇ Memory     │                                                                │
│ ◇ Connections│                                                                │
│ ──────────── │                                                                │
│ ◇ Evals      │                                                                │
│ ◇ Marketplace│                                                                │
│ ⚙ Settings   │                                                                │
└──────────────┴──────────────────────────────────────────────────────────────┘
 Top-right persistent: workspace switcher, ⌘K, live metered spend, account.
 The spend chip is the meter-to-revenue wedge, always in frame «billing usage».
```

---

## 1. Ask — the front door

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Ask                                              Agent: [ Auditor ▾]  ⌘K    │
│                                                   «agent.definition.list»    │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  You:  audit oxagen.sh for broken links and weak SEO                  │  │
│  │                                                                        │  │
│  │  Auditor ▸ planning…                                                   │  │
│  │   1. crawl site   2. check links   3. score SEO   [ Approve plan ]     │  │
│  │                                       «agent.plan.approve»             │  │
│  │  ▸ tool: web.fetch  oxagen.sh              ✓  120ms   $0.001           │  │
│  │  ▸ tool: browser.read  /pricing            ⧖  running                  │  │
│  │  ▸ grounded in: ◈ Pricing Page, ◈ SEO Policy   «NodeRef, cited label»  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Type, or run a command:  /audit ______________________   [ Send ▸ ]  │  │
│  │  /audit  /summarize  /triage        «command.* catalog, slash surface»│  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
 New vs today: agent picker (run any published agent), slash commands in the
 composer, inline plan-approval, and grounded-in citation chips by label not UUID.
```

---

## 2. Studio → Agents (list)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Studio · Agents                                  [ + New agent ]           │
│  «agent.definition.list»                                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │ Name        Model        Tools  Skills  Status   Deploy   Last run  $   ││
│  │ ─────────────────────────────────────────────────────────────────────  ││
│  │ Auditor     precise·5    7      2       ● active  ◉ on     2m ago   $4.1 ││
│  │ Triage Bot  fast·haiku   3      1       ● active  ◉ on     1h ago   $0.3 ││
│  │ Draft Agent balanced     12     0       ○ draft   ○ off    —        —    ││
│  └────────────────────────────────────────────────────────────────────────┘│
│  Row → agent detail/builder. Status ● active / ○ draft «agents.status».      │
│  Deploy toggle «agent.deploy». Cost column «billing usage per agent».        │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Studio → Agent Builder  ★ the centerpiece

The whole point of the overhaul. One screen, a left step-rail, a live preview on the right.
Every step binds to a slice of `AgentDefinition`. Shown mid-build for the "Auditor" agent.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ‹ Agents   Auditor   ○ draft v3          [ Save draft ]  [ Publish v3 ▸ ]  │
│                                            «agent.definition.update/publish» │
│ ┌───────────────┬──────────────────────────────────────┬──────────────────┐│
│ │ STEPS         │  ② Instructions                       │  LIVE PREVIEW    ││
│ │ ① Identity  ✓ │                                        │  ┌────────────┐  ││
│ │ ② Instructions│  System prompt                         │  │ Auditor    │  ││
│ │ ③ Equip     ● │  ( ) Write inline                      │  │ precise·5  │  ││
│ │ ④ Ground      │  (•) Use a saved Prompt   ▾            │  │ 7 tools    │  ││
│ │ ⑤ Triggers    │      ┌──────────────────────────────┐  │  │ 2 skills   │  ││
│ │ ⑥ Govern      │      │ Website Audit  v2   «prompt» │  │  │ graph: R   │  ││
│ │ ⑦ Review      │      └──────────────────────────────┘  │  │ triggers:2 │  ││
│ │               │  + Append instructions (optional)      │  │ risk: med  │  ││
│ │               │  ┌──────────────────────────────────┐  │  └────────────┘  ││
│ │               │  │ Always cite the page you scored. │  │  Est. cost/run   ││
│ │               │  └──────────────────────────────────┘  │  ~ $0.9–1.4      ││
│ │               │        «AgentDefinition.instructions»  │  «meter estimate»││
│ └───────────────┴──────────────────────────────────────┴──────────────────┘│
└────────────────────────────────────────────────────────────────────────────┘
```

### Step ③ Equip — the one uniform picker (skills + tools + MCP + subagents)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ③ Equip Auditor                          «AgentDefinition.agentTools[]»    │
│  Add anything the agent can use. All four load the same way.                 │
│  ┌── Filter ──────────────────────────────────────────────────────────────┐│
│  │ [ Skills ] [ Tools ] [ MCP servers ] [ Subagents ]   search ______     ││
│  └────────────────────────────────────────────────────────────────────────┘│
│  EQUIPPED (9)                                                                 │
│   ⊟ skill  Brand Voice            v1   ✎   ✕    «type:skill  ref:brand-voice»│
│   ⊟ skill  SEO Audit              v3   ✎   ✕                                 │
│   ⊟ tool   web.fetch          low        ✕    «type:function»               │
│   ⊟ tool   browser.read       low        ✕                                  │
│   ⊟ tool   browser.screenshot med  ⚑approve ✕  «riskLevel, requiresApproval»│
│   ⊟ tool   graph.search       low        ✕                                  │
│   ⊟ mcp    Ahrefs (custom)    ext  ⚑consent✕   «type:mcp_server»            │
│   ⊟ agent  Link Checker (sub)            ✕    «type:agent  → subagent»       │
│  ────────────────────────────────────────────────────────────────────────  │
│  AVAILABLE                                        [ Browse marketplace ▸ ]   │
│   + tool   documents.generate  low    « surfaces includes 'agent' »          │
│   + tool   image.analyze       low                                           │
│   + skill  Accessibility Check v1     [ install ]  «not yet in workspace»    │
│  Risk + approval shown per tool inline. Red ⚑ = requires approval at run.     │
└────────────────────────────────────────────────────────────────────────────┘
```

### Step ④ Ground — graph access

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ④ Ground Auditor                          «AgentDefinition.graph: GraphAccess»│
│  Ontology        [ acme-web  ▾ ]           «graph.ontologyId»                │
│  Mode            (•) Read   ( ) Read + extend        «graph.mode»            │
│  Retrieval       [ hybrid ▾ ]  scope to types: [Page][Link][Metric] +        │
│                                «retrieval.strategy, scopeToTypes[]»          │
│  Budget          max hops [2]  max nodes [40]  min relevance [0.6]           │
│                  max traversal [800] ms         «graph.budget»               │
│  ▸ Preview: a sample query shows which nodes would ground an answer, cited.   │
└────────────────────────────────────────────────────────────────────────────┘
```

### Step ⑤ Triggers · ⑥ Govern · ⑦ Review

```
┌─ ⑤ Triggers ─────────────────────────┐  ┌─ ⑥ Govern ────────────────────────┐
│ «agent_triggers»                      │  │ Who can run this agent            │
│ [x] Manual (Ask + API)                │  │  Roles: [Owner][Admin][Member] +  │
│ [x] Command   /audit        ▾         │  │        «role_grants for agent.run»│
│      «trigger:event ← command»        │  │ Approval policy                   │
│ [ ] Schedule  cron ________           │  │  (•) Inherit tool risk rules      │
│ [ ] Event     source ▾  type ▾        │  │  ( ) Require approval for ALL      │
│      connection ▾  filter {…}         │  │  ( ) Never (trusted, low-risk)    │
└───────────────────────────────────────┘  │        «requiresApproval»         │
                                            └───────────────────────────────────┘
┌─ ⑦ Review & Publish ───────────────────────────────────────────────────────┐
│ Auditor  v3   → immutable snapshot on publish   «agent_versions, checksum»   │
│ 2 skills · 7 tools · 1 MCP · 1 subagent · graph read · triggers: manual,/audit│
│ Diff vs v2:  + Brand Voice skill,  + Ahrefs MCP,  prompt v1→v2                │
│ [ Publish v3 ]   [ Publish + Deploy ]         «agent.definition.publish»      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Studio → Skills (list + new skill = the Brand Voice example)

```
┌── Skills ──────────────────────────────┐  ┌── New skill ───────────────────────┐
│ «skill.workspace.list»   [ + New skill]│  │ «skill.create»                     │
│ Name          Source  Ver  Used  On    │  │ Name  [ Brand Voice            ]   │
│ Brand Voice   tenant  v1   14    ●     │  │ Slug  brand-voice (auto)           │
│ SEO Audit     tenant  v3   88    ●     │  │ Desc  [ Oxagen brand voice for … ] │
│ Accessibility builtin v1   —     ○     │  │ Weight  ( )low (•)high ( )critical │
│ Row → versions, activate, download.    │  │        «metadata.weight»           │
│ builtin vs tenant «skills.source».     │  │ Body (.skill.md ≤ 32k)             │
└────────────────────────────────────────┘  │ ┌────────────────────────────────┐ │
                                             │ │ # Brand Voice                  │ │
                                             │ │ Plain words. Pain first. No    │ │
                                             │ │ em-dashes. Oxford commas. …    │ │
                                             │ │ «skill_versions.body»          │ │
                                             │ └────────────────────────────────┘ │
                                             │ References  [ + add file ]          │
                                             │ [x] Activate on save                │
                                             │            [ Create skill ▸ ]       │
                                             └─────────────────────────────────────┘
```

---

## 5. Studio → Prompts (the saved-prompt library — new)

```
┌── Prompts ─────────────────────────────┐  ┌── Prompt: Website Audit  v2 ───────┐
│ Saved system prompts   [ + New prompt ]│  │ Name  [ Website Audit           ]  │
│ «new prompt template library»          │  │ Category  ▾ investigate            │
│ Name            Cat        Ver  Used   │  │ Body (mustache {{var}})            │
│ Website Audit   investigate v2  6      │  │ ┌────────────────────────────────┐ │
│ Release Notes   communicate v1  2      │  │ │ You are a website auditor.     │ │
│ Triage          investigate v1  9      │  │ │ Crawl {{domain}}. Score SEO,   │ │
│                                        │  │ │ links, and accessibility.      │ │
│ These plug into agents (step ②) and    │  │ │ Cite every page you scored.    │ │
│ into commands. One prompt, reused.     │  │ └────────────────────────────────┘ │
│                                        │  │ Variables: domain (string, req)    │
│ Note: distinct from the workspace-wide │  │ Used by: Auditor agent, /audit cmd │
│ prompt in Settings «prompt.settings».  │  │ [ Save v2 ]   [ Save as new ]      │
└────────────────────────────────────────┘  └─────────────────────────────────────┘
 Design note: the workspace-level orchestration prompt stays in Settings
 (append-only, «prompt.settings.write»). This library is the reusable, named layer
 that today does not exist. Two clearly separated concepts, two clearly separate homes.
```

---

## 6. Studio → Commands (slash commands — new, the `/audit` example)

```
┌── Commands ────────────────────────────┐  ┌── Command: /audit ─────────────────┐
│ Slash commands       [ + New command ] │  │ Trigger  / [ audit            ]    │
│ «new command entity + agent_triggers»  │  │ Description [ Run a full site … ]  │
│ Command    Runs        Prompt     On   │  │ Runs agent  [ Auditor        ▾ ]   │
│ /audit     Auditor     Web Audit  ●    │  │            «agent.definition.list» │
│ /triage    Triage Bot  Triage     ●    │  │ With prompt [ Website Audit ▾ ]    │
│ /summarize (inline)    —          ●    │  │ Argument hint  [ <domain> ]        │
│                                        │  │ Inputs → variables:                │
│ Row → editor. On = enabled.            │  │   $1 → {{domain}}   «$ARGUMENTS»   │
│ Available in Ask composer + CLI + API. │  │ Model override ( ) default (•) fast │
│ Parity with CLI .oxagen/commands/*.md. │  │ Visibility  (•) Workspace ( ) Org  │
│                                        │  │ Preview:  /audit oxagen.sh         │
│                                        │  │ [ Save command ▸ ]                 │
└────────────────────────────────────────┘  └─────────────────────────────────────┘
```

---

## 7. Studio → Tools (the capability catalog)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Studio · Tools           «agent.tool.list» — after allowlist + risk filter  │
│  Search ____   Domain [ all ▾]  Risk [ all ▾]  [x] agent-surfaced only        │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Tool               Domain     Risk   Approval  Installed  Used by       │ │
│  │ web.fetch          web        low     no        core       12 agents    │ │
│  │ browser.screenshot browser    med     yes ⚑     core        3 agents    │ │
│  │ graph.search       graph      low     no        core       20 agents    │ │
│  │ repo.pr.open       repo       high    yes ⚑     GitHub plg  2 agents    │ │
│  │ image.generate     image      low     no        Media plg   1 agent     │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│  Row → detail: input/output schema, riskLevel, defaultRoles, which plugin     │
│  ships it, which agents equip it. Read + govern; not a call surface.          │
│  [ Manage grants in Access → Roles ]   [ Install more in Marketplace ]        │
└────────────────────────────────────────────────────────────────────────────┘
 This is the "211 tools" made legible: what exists, what it costs in risk, who uses it.
```

---

## 8. Fleets (fan-out with lineage + cost — new)

```
┌── Fleets (list) ───────────────────────┐
│ «agent.subagent.fanout.list»           │
│ Fleet         Agents  Status   Cost    │
│ Site Audit    5       ● done    $6.20  │
│ Repo Sweep    12      ⧖ running $3.10  │
└────────────────────────────────────────┘
┌── Fleet: Site Audit ───────────────────────────────────────────────────────┐
│ «agent.subagent.fanout.get» — lineage + cost per branch                      │
│                                                                              │
│   Auditor (root) ─┬─ Link Checker    ✓  1.2k tok   $0.9   ◈ 3 pages cited    │
│                   ├─ SEO Scorer       ✓  2.0k tok   $1.4   ◈ 5 pages cited    │
│                   ├─ A11y Scanner     ✓  1.1k tok   $0.8                     │
│                   ├─ Perf Auditor     ⧖  running                             │
│                   └─ Aggregator       ⋯  waiting    «agent.subagent.aggregate»│
│                                                                              │
│  Total: 5 agents · 6.5k tokens · $6.20 · every step emits lineage + cost.    │
│  [ Open in Runs ]   [ Cancel fleet ]        «agent.subagent.cancel»          │
└──────────────────────────────────────────────────────────────────────────────┘
 On-vision: "structured fan-out where each agent grounds in a shared graph and every
 step emits lineage + cost." This screen is that sentence.
```

---

## 9. Runs (was Activity) — list + trace with citations + cost

```
┌── Runs ────────────────────────────────────────────────────────────────────┐
│ «agent.execution.list»   Filter: agent ▾  status ▾  date ▾                   │
│ When     Agent      Trigger   Steps  Status   Tokens   Cost   Grounded       │
│ 2m ago   Auditor    /audit    14     ● ok      6.5k    $4.10   ◈ 8 nodes     │
│ 1h ago   Triage Bot event     3      ● ok      0.4k    $0.02   —             │
│ 3h ago   Auditor    manual    9      ⚠ approval 2.1k   $0.30   ◈ 3 nodes     │
└──────────────────────────────────────────────────────────────────────────────┘
┌── Run  aex_9f2… · Auditor · /audit oxagen.sh ──────────────────────────────┐
│ «agent.trace.get» span tree                       tokens 6.5k · cost $4.10  │
│  ▾ plan.create                       ok    30ms                             │
│  ▾ web.fetch  oxagen.sh              ok   120ms   $0.001                     │
│  ▾ browser.screenshot /pricing       ⚑→✓ approved by MA   «approval linked» │
│  ▾ graph.search "pricing tiers"      ok    45ms   ◈ Pricing Page, ◈ SEO Pol │
│       grounded-in (click → property popover, copyable id)  «NodeRef»        │
│  ▾ documents.generate  audit.pdf     ok   900ms   $0.03   [ download ]      │
│  Cost breakdown ▸   Lineage ▸ (fleet)   Replay ▸   «agent.debug.trace»      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Approvals (HITL inbox — new)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Approvals                              [ mine ] [ all ]     3 pending        │
│  «agent.approval_requests + agent_plans + agent.mcp.consent + semantic.*»    │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ ⚑ HIGH   repo.pr.open on acme/site          Auditor · 2m   [✓][✕][…]    │ │
│  │   Preview: open PR "fix 12 broken links"    «inputPreview, riskLevel»   │ │
│  │ ⚑ MED    browser.screenshot /admin          Auditor · 5m   [✓][✕]       │ │
│  │ ⚙ TOOL   production deploy request             Auditor · 1h [✓][✕]      │ │
│  │          acme/site · release workflow          «agent approval request» │ │
│  │ ⌘ PLAN   Auditor plan: 3 steps              /audit    · 1h  [ Review ]  │ │
│  │ 🔌 CONSENT Ahrefs MCP first use: rank.get    Auditor · 1h   [✓][✕]      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│  One inbox for every human-in-the-loop decision the platform can raise:       │
│  tool approvals, plan approvals, MCP consent, and inferred-edge approvals.    │
│  Resolving links back to the Run that raised it. Bulk approve for low risk.    │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Marketplace (browse + MCP + installed — promoted out of settings)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Marketplace   [ Browse ] [ MCP servers ] [ Installed ] [ Registries ]       │
│  «plugin.catalog.browse»          search ____   tier ▾   type ▾              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ ▣ Media      │ │ ▣ Documents  │ │ ▣ SEO Pack   │ │ ▣ Ahrefs MCP │        │
│  │ image/video  │ │ pdf/docx     │ │ audit skills │ │ external MCP │        │
│  │ free · ga    │ │ free · ga    │ │ premium·beta │ │ custom       │        │
│  │ [ Install ]  │ │ [ Installed ]│ │ [ Install ]  │ │ [ Connect ]  │        │
│  │ 6 tools      │ │ 3 tools      │ │ 2 skills     │ │ auth: oauth  │        │
│  │ «manifest»   │ │ minPlan:build│ │ «entitlement»│ │ «mcp.register»│       │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │
│  Install shows: contracts claimed, tier/plan gate, scopes, risk of tools.     │
├── MCP servers tab ──────────────────────────────────────────────────────────┤
│  Add server: (•) From catalog  ( ) Custom URL  ( ) Local file                │
│  URL [ https://mcp.ahrefs… ]  transport ▾  auth (•)OAuth ( )secret           │
│  Discovered tools: rank.get, backlinks.list …  health ● ok  «mcp_servers»    │
│  [ Connect ]  → tools become available in Studio Equip.                       │
└──────────────────────────────────────────────────────────────────────────────┘
 One home for both plugins and MCP servers: both extend the agent's tool set.
```

---

## 12. Knowledge → Connections (was repos) + Graph

```
┌── Connections ─────────────────────────────────────────────────────────────┐
│  «connection.* + repo.* + integration.*»   [ + New connection ]              │
│  Source        Type     Health   Nodes   Last sync   Mappings                │
│  acme/site     GitHub   ● ok      1,204   3m ago      [ edit ▾ ]  «repo.*»   │
│  Notion (docs) app      ● ok      420     1h ago      [ suggest ] «connection│
│  Ahrefs        api      ⚠ reauth  —       —           [ fix ]      .mappings»│
│  Dual-write shown: Postgres (cursor, health) + Neo4j (entities, edges).      │
├── Graph (explore) ──────────────────────────────────────────────────────────┤
│  «graph.search / ontology.neighbors»    query ____                           │
│    ◈ Pricing Page ──LINKS_TO──▸ ◈ Signup   ◈ SEO Policy ──APPLIES_TO──▸ ◈ Home│
│  Node click → property popover, copyable id (only place raw id appears).      │
│  Only materialized, authorized relationships are displayed.                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Access → Members & Roles (people + the grant matrix — new)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Access   [ People ] [ Roles ] [ Requests ] [ Sessions ] [ Reviews ]         │
│  «organization.* + iam roles/grants/access_requests»                         │
├── Roles tab ────────────────────────────────────────────────────────────────┤
│  Roles           [ + New role ]        Editing: Auditor Operator             │
│  ● Owner                    Capability grant matrix «role_grants.effect»      │
│  ● Admin                    ┌──────────────────────────────────────────────┐ │
│  ● Member                   │ Capability            allow  deny  approve    │ │
│  ● Auditor Operator ◂ edit  │ agent.definition.run  (•)    ( )   ( )        │ │
│  ● Analyst (custom)         │ repo.pr.open          ( )    ( )   (•)  ⚑     │ │
│                             │ browser.screenshot    (•)    ( )   ( )        │ │
│  Scope: (•) Org ( ) Workspace│ secret.reveal        ( )    (•)   ( )        │ │
│  Inherit from: [ Member ▾ ] │ billing.subscription  ( )    (•)   ( )        │ │
│                             └──────────────────────────────────────────────┘ │
│  Search 287 capabilities. Effect = allow / deny / require approval.          │
│  This is the RBAC editor the backend always had and the app never showed.     │
├── Requests tab ─────────────────────────────────────────────────────────────┤
│  JIT access requests  «access_requests»   pending 2                          │
│  user@acme wants repo.pr.open on acme/site for 4h  [ approve ][ deny ]        │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 14. Billing → Reseller (meter-to-revenue — the wedge, new)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Billing   [ Subscription ] [ Usage ] [ Invoices ] [ Budgets ] [ Reseller ]  │
├── Reseller tab (meter-to-revenue) ──────────────────────────────────────────┤
│  Turn observed agent usage into bills for YOUR customers.                     │
│  «ClickHouse usage → Stripe loop»                                            │
│                                                                              │
│  Your customers        Plan          This month usage    You bill them        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Northwind Co.         metered       48k tokens · 1.2k runs   $312            │
│  Contoso               flat + over   210k tokens             $1,940           │
│                                                                              │
│  Meters you resell:   [ tokens ×1.4 ]  [ runs $0.02 ]  [ tool: repo.pr $0.50]│
│                        «meter markup rules → Stripe prices»                   │
│  [ + Define a reseller meter ]   [ Sync to Stripe ]   [ Preview invoice ]     │
│                                                                              │
│  This is Oxagen's core wedge on one screen: you meter what agents did, mark   │
│  it up, and bill your customers through Stripe. Not a spend dashboard,        │
│  revenue infrastructure.                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 15. The golden path, screen by screen

The end-to-end story, showing how the surfaces connect. This is the demo script and the
e2e test spine.

```
 1. Studio → Skills → New skill
      Name "Brand Voice", weight high, body = voice rules.  «skill.create»
                              │
                              ▼
 2. Studio → Prompts → New prompt
      "Website Audit", body with {{domain}}, cite every page. «prompt template»
                              │
                              ▼
 3. Studio → Agents → New agent  "Auditor"
      ② Instructions → use prompt "Website Audit"
      ③ Equip → + skill Brand Voice, + SEO Audit, + web.fetch, browser.read,
                 browser.screenshot(⚑), graph.search, + Ahrefs MCP, + Link Checker sub
      ④ Ground → ontology acme-web, hybrid, read
      ⑤ Triggers → manual + command /audit
      ⑥ Govern → Member can run; inherit tool risk
      ⑦ Publish v3.                          «agent.definition.publish»
                              │
                              ▼
 4. Studio → Commands → New command  /audit
      runs Auditor with prompt Website Audit, $1 → {{domain}}.  «command entity»
                              │
                              ▼
 5. Ask →  /audit oxagen.sh
      plan approved, tools run, Ahrefs consent granted, screenshot approved.
                              │
                              ▼
 6. Fleets → Site Audit
      Auditor fans out to Link Checker, SEO Scorer, A11y, Perf, Aggregator.
      Every branch shows tokens, cost, cited nodes.       «fanout lineage»
                              │
                              ▼
 7. Approvals →  resolve the repo.pr.open + screenshot + Ahrefs consent.
                              │
                              ▼
 8. Runs → aex_9f2  the trace, grounded-in citations, $4.10 metered.
                              │
                              ▼
 9. Billing → Reseller  the $4.10 (×1.4) becomes a $5.74 line on Northwind's invoice.
```

Nine screens, one story, every noun a first-class object, every step a governed, metered,
grounded, typed contract. That is capability parity, and that is the wedge, on screen.
