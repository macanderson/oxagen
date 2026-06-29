<!-- Generated: 2025-07-10 | Files scanned: 819 (app) + 200 (cli) | Token estimate: ~900 -->

# Frontend Architecture

## apps/app — Next.js 15 Web Application

### Entry Points
```
apps/app/src/app/layout.tsx              → root layout (fonts, providers)
apps/app/src/app/page.tsx               → root redirect
apps/app/src/app/(auth)/layout.tsx      → unauthenticated shell
apps/app/src/app/[orgSlug]/layout.tsx   → org shell (sidebar, nav)
apps/app/src/app/[orgSlug]/[workspaceSlug]/layout.tsx → workspace shell
```

### Page Tree
```
/                                        → redirect to org
/(auth)
  /login                                 → LoginPage
  /signup                                → SignupPage
  /forgot-password                       → ForgotPasswordPage
  /reset-password                        → ResetPasswordPage
  /verify                                → VerifyPage
/(onboarding)
  /new-organization                      → NewOrganizationPage

/account
  /                                      → AccountPage
  /profile                               → ProfilePage
  /preferences                           → PreferencesPage
  /privacy                               → PrivacyPage
  /security                              → SecurityPage

/cli/authorize                           → CLI OAuth loopback
/github/setup                            → GitHub App install

/[orgSlug]
  /                                      → org dashboard
  /billing                               → BillingPage
  /members                               → MembersPage
  /access                                → AccessPage
  /security                              → SecurityPage
  /developer                             → DeveloperPage (API keys)
  /settings                              → OrgSettingsPage
  /new-workspace                         → NewWorkspacePage

/[orgSlug]/[workspaceSlug]
  /                                      → workspace home (chat)
  /ask                                   → AskPage (one-shot query)
  /chat                                  → ChatPage (conversation)

  /activity
    /                                    → ActivityPage
    /approvals                           → ApprovalsPage
    /audit                               → AuditPage
    /runs                                → RunsPage (subagent fanouts)

  /automation
    /                                    → AutomationPage
    /agents                              → AgentsListPage + AgentEditorForm
    /triggers                            → TriggersPage
    /playbooks                           → PlaybooksPage
    /event-sources                       → EventSourcesPage

  /knowledge
    /                                    → KnowledgePage
    /graph                               → GraphPage (Neo4j viz, reagraph)
    /explore                             → GraphExplorerPage
    /memories                            → MemoriesPage
    /nodes                               → NodesPage
    /nodes/[nodeId]                      → NodeDetailPage
    /sources                             → SourcesPage (connectors)

  /settings
    /general                             → WorkspaceGeneralForm
    /environments                        → EnvironmentsPanel
    /github                              → GithubConnectionSettings
    /knowledge                           → KnowledgeSettingsPage
    /memory                              → MemoryPolicyForm
    /model-keys                          → ModelKeysPage
    /models                              → ModelsForm
    /plugins                             → WorkspacePluginsPanel + RegistryManager
    /prompts                             → PromptSettingsForm
    /skills                              → SkillsPanel
    /skills/[skillSlug]                  → SkillDetailPanel
    /members                             → MembersPage
```

### Component Hierarchy
```
apps/app/src/components/
  shell/
    ask/                                 → AskShell (one-shot UI)
  chat/
    chat-shell-client.tsx                → main chat UI, StepMarker, streaming
    registry-components/
      automation-create-inline-steps.tsx → StepsEditor
      capability-chain-card.tsx          → StepStatus
  agent-panel/                          → agent sidebar panel
  knowledge/
    graph/                              → Neo4j graph visualization (reagraph)
    graph-explorer/                     → interactive graph explorer
    memories/                           → memory list/management
    schema-builder/                     → ontology schema UI
    sources/                            → data source connectors
  conversations/                        → conversation list/management
  auth/                                 → login/signup forms
  billing/                              → plan/credits UI
  connectors/                           → integration connector cards
  org/                                  → org management components
  plugins/                              → plugin catalog/management
  security/                             → security events, policy
  settings/                             → shared settings panels
  workspace/                            → workspace switcher, nav
  media/                                → image/video/asset upload
  loading/                              → skeleton loaders
  ui/                                   → local overrides of @oxagen/ui
```

### State Management
- **No global store** (Zustand/Jotai not used at app level)
- **Server state**: Next.js Server Actions + RSC data fetching
- **Client state**: React `useState` / `useReducer` per component
- **Mutations**: Server Actions in `*-actions.ts` / `actions.ts` co-located with pages
- **Streaming**: SSE via `chat/stream` endpoint, consumed in `chat-shell-client.tsx`
- **URL state**: `useSearchParams` for filters/tabs

### Key Shared Libs
```
apps/app/src/lib/
  routes.ts           → typed route helpers
  sidebar.ts          → sidebar nav config
  actions/            → shared server action utilities
  ask/                → ask-mode helpers
  command-menu/       → ⌘K search integration
  page-context/       → RSC page context helpers
  tenant/             → org/workspace context resolution
```

### Data Fetching Pattern
```
page.tsx (RSC)
  → direct DB query via @oxagen/database (server-only)
  OR → fetch from /api/* Next.js API routes
  → passes data to Client Components as props
  → mutations via Server Actions (apps/app/src/app/*/actions.ts)
  → revalidatePath / revalidateTag after mutations
```

---

## apps/cli — Terminal Agent (Ink + Commander)

### Entry Points
```
apps/cli/src/index.tsx          → binary entry, Commander setup
apps/cli/src/program.tsx        → CLI program definition
```

### Command Structure
```
oxagen                          → interactive REPL (default)
oxagen ask "<prompt>"           → one-shot mode
oxagen init                     → project init
oxagen fleet                    → multi-agent fleet view
```

### Agent Loop
```
apps/cli/src/agent/
  loop.ts                       → main ReAct loop
  model-router.ts               → model tier selection (fast/balanced/precise)
  model.ts                      → AI SDK call wrapper
  planner.ts                    → task planning
  permissions.ts                → tool permission gates
  system-prompt.ts              → system prompt assembly
  prompt-enhancer.ts            → context injection
  rate-card.ts                  → token/cost tracking
  timeouts.ts                   → per-tool timeout config
  memory.ts                     → project-scoped memory
  code-graph.ts                 → local code graph provider
  lineage-projection.ts         → trace lineage
  project-context.ts            → cwd/git context
  adapters/
    code-graph-provider.ts
    code-map-provider.ts
    graph-sync-provider.ts
    memory-provider.ts
    platform-agent-ai.ts        → API gateway adapter
    workspace.ts                → workspace context
  fleet/
    orchestrator.ts             → multi-agent orchestration
    store.ts                    → fleet state (per-project key)
    memory.ts                   → fleet-shared memory
    git-isolation.ts            → per-agent git worktree
    types.ts
```

### TUI Components (Ink)
```
apps/cli/src/tui/
  agent-view/
    index.tsx                   → main agent TUI
    activity-feed.tsx           → tool call feed
    budget-bar.tsx              → token budget display
    compile-panel.tsx           → code compilation status
    memory-panel.tsx            → memory display
    session-panel.tsx           → session info
    status-bar.tsx              → status line
  fleet-view/
    fleet-app.tsx               → fleet orchestrator TUI
    agent-row.tsx               → per-agent status row
    dispatch-input.tsx          → task dispatch input
    fleet-summary.tsx           → summary stats
  welcome-screen/               → animated welcome
  banner.tsx
  theme.ts
```

### Settings / Config
```
apps/cli/src/settings/
  schema.ts                     → settings Zod schema
  resolve.ts                    → config file resolution (~/.config/oxagen/)
  runtime.ts                    → runtime overrides
  gate.ts                       → feature gates
  hooks.ts                      → settings change hooks
  permissions-gate.ts           → permission enforcement
  mcp-write.ts                  → MCP server config write
  write.ts                      → config file write
```

### REPL
```
apps/cli/src/repl/
  interactive.tsx               → full interactive REPL (Ink)
  one-shot.ts                   → non-interactive single-turn
  components.tsx                → shared REPL components
  slash-menu.tsx                → /command menu
  escape-action.ts              → Escape key handler
```

### Slash Commands / Rules
```
apps/cli/src/slash/             → /command catalog, loader, expand
apps/cli/src/rules/             → .oxagen rules enforcement
apps/cli/src/mcp/client.ts      → local MCP client
apps/cli/src/lib/
  api.ts                        → API client (to api.oxagen.sh)
  session.ts                    → session management
  pkce.ts                       → PKCE OAuth flow
  loopback-login.ts             → CLI auth loopback
  memory-client.ts              → memory API client
  workspace-link.ts             → workspace linking
  differential-context.ts       → diff-based context
  structured-tool-io.ts         → tool I/O formatting
```
