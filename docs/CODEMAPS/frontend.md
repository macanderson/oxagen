<!-- Generated: 2026-07-06, corrections applied 2026-07-10 | Files scanned: 634 (app) | Token estimate: ~600 -->

# Frontend Architecture

## apps/app — Next.js 16 Web Application (16.2.10)

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
  /two-factor                            → TwoFactorPage
  /verify                                → VerifyPage
/(onboarding)
  /new-organization                      → NewOrganizationPage

/account
  /                                      → AccountPage
  /profile                               → ProfilePage
  /preferences                           → PreferencesPage
  /privacy                               → PrivacyPage
  /security                              → SecurityPage

/github/setup                            → GitHub App install
/api/v1/*                                → thin proxy routes into apps/api
/api/auth/[...all]                       → Better Auth handler
/api/command-menu/search|suggestions     → ⌘K search backend
/api/schema/[...path]                    → JSON schema passthrough

/[orgSlug]
  /                                      → org dashboard
  /billing
    /subscription                        → BillingSubscriptionPage
    /usage                                → BillingUsagePage
    /invoices                             → BillingInvoicesPage
  /members
    /pending                              → PendingMembersPage
  /access
    /sessions                             → AccessSessionsPage
    /reviews                              → AccessReviewsPage
  /security
    /mfa                                  → SecurityMfaPage
    /audit                                → SecurityAuditPage
    /compliance                           → SecurityCompliancePage
    /trust                                → SecurityTrustPage
  /developer
    /mcp                                  → DeveloperMcpPage
    /tokens                               → DeveloperTokensPage
  /settings
    /general                              → OrgGeneralSettingsPage
    /members                              → OrgMembersSettingsPage
    /billing                              → OrgBillingSettingsPage
    /privacy                              → OrgPrivacySettingsPage
  /new-workspace                          → NewWorkspacePage

/[orgSlug]/[workspaceSlug]
  /                                      → workspace home (chat)
  /ask                                   → AskPage (one-shot query)
  /chat                                  → ChatPage (conversation)

  /activity
    /                                    → ActivityPage (execution list)
    /[executionId]                       → ExecutionDetailPage (span tree, child-run trace, debug)

  /workbench                             → redirects to /workbench/agents
    /agents                              → WorkbenchAgentsPage + AgentBuilder (new/[agentId])
    /tools                               → Agent Tools hub (All Tools / Skills / MCP Servers / Capabilities)
    /environments                        → WorkbenchEnvironmentsPage (EnvironmentsPanel)
    /sandboxes                           → WorkbenchSandboxesPage (sessions + SandboxTemplatesPanel)

  /marketplace                           → MarketplacePage
    /browse                              → BrowseMarketplacePage (plugin/skill catalog)
    /installed                           → InstalledMarketplacePage
    /mcp                                 → McpMarketplacePage
    /integrations                        → MarketplaceIntegrationsPage
    /agent-tools                         → MarketplaceAgentToolsPage

  /evals                                 → EvalsPage (datasets + runs, LLM-as-judge)
    /runs                                → EvalRunsListPage
    /runs/[runId]                        → EvalRunDetailPage

  /knowledge
    /                                    → KnowledgePage
    /explore                             → GraphExplorerPage (Neo4j viz, reagraph)
    /inference                           → InferenceReviewPage (semantic edge approve/reject)
    /memories                            → MemoriesPage
    /nodes                               → NodesPage
    /repos                               → ReposPage (GitHub connectors)

  /settings
    /general                             → WorkspaceGeneralForm
    /budget                              → BudgetPolicyForm (workspace budget policy)
    /github                              → GithubConnectionSettings
    /knowledge                           → KnowledgeSettingsPage
    /memory                              → MemoryPolicyForm
    /mcp-server-registries               → RegistryManager (registry admin lives ONLY here)
    /models                              → ModelsForm
    /prompts                             → PromptSettingsForm
    /members                             → MembersPage
    (/environments, /plugins, /skills    → redirects into Workbench)
```

### Component Hierarchy
```
apps/app/src/components/
  shell/
    sidebar.tsx, sidebar-item.tsx, sidebar-context.tsx → nav shell (see lib/sidebar.ts)
    ask/                                 → AskShell (one-shot UI)
  chat/
    chat-shell-client.tsx                → main chat UI, StepMarker, streaming
    registry-components/                 → rendered structured tool-output cards
      automation-create-inline-steps.tsx → StepsEditor
      capability-chain-card.tsx          → StepStatus
    structured-value.tsx                 → StructuredValueProps renderer
  agent-panel/                          → agent sidebar panel
  activity/
    span-tree.tsx                        → execution step tree (StepNode)
  knowledge/
    graph/                               → Neo4j graph visualization (reagraph)
    graph-explorer/                      → interactive graph explorer
    memories/                            → memory list/management
    schema-builder/                      → ontology schema UI
    sources/                             → data source connectors
  conversations/                        → conversation list/management
  auth/                                  → login/signup forms
  billing/                               → plan/credits UI
  connectors/                            → integration connector cards
  org/                                   → org management components
  plugins/                               → plugin catalog/management
  security/                              → security events, policy
  settings/                              → shared settings panels
  workspace/                             → workspace switcher, nav
  media/                                 → image/video/asset upload
  loading/                               → skeleton loaders
  pwa/                                   → PWA install/update prompts
  brand/                                 → logo/wordmark assets
  ui/                                    → local overrides of @oxagen/ui
```

### State Management
- **No global store** (Zustand/Jotai not used at app level)
- **Server state**: Next.js Server Actions + RSC data fetching
- **Client state**: React `useState` / `useReducer` per component
- **Mutations**: Server Actions in `*-actions.ts` / `actions.ts` co-located with pages (e.g. `settings/budget/budget-action.ts`)
- **Streaming**: SSE via `chat/stream` endpoint, consumed in `chat-shell-client.tsx`
- **URL state**: `useSearchParams` for filters/tabs

### Key Shared Libs
```
apps/app/src/lib/
  routes.ts           → typed route helpers (org/workspace/account URL builders)
  sidebar.ts           → sidebar nav config + breadcrumb targets (source of truth for page tree)
  actions/             → shared server action utilities
  ask/                 → ask-mode helpers
  command-menu/        → ⌘K search integration
  page-context/        → RSC page context helpers
  tenant/              → org/workspace context resolution
```

### Data Fetching Pattern
```
page.tsx (RSC)
  → direct DB query via @oxagen/database (server-only)
  OR → fetch from /api/* Next.js API routes (thin proxy to apps/api)
  → passes data to Client Components as props
  → mutations via Server Actions (apps/app/src/app/*/actions.ts)
  → revalidatePath / revalidateTag after mutations
```
