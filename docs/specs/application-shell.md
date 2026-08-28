---
title: "Application Shell"
description: "Archived spec & plan — status: partially shipped (audited 2026-07-03)."
---

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Application Shell's core navigation architecture has shipped with three modes (workspace/org/account), URL-driven sidebar configuration, WAI-ARIA tabs, and intent-routing Ask bar. However, several promised sidebar sections were deliberately removed (Automation, Activity) or not fully implemented (Studio, full tab inventories for org-level pages). The workspace mode has Ask, Knowledge, and Settings, but missing the Automation and Activity areas that the spec promised. Account mode has Profile, Security, and Privacy but not Cases or Notifications. Core infrastructure exists and is functional.

**Implementation evidence**

- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/components/shell/app-shell.tsx — AppShell component implementing mode-aware layout
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/lib/sidebar.ts — Sidebar configuration for three modes with SidebarItem type matching spec §14
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/components/ui/page-tabs.tsx — URL-driven WAI-ARIA tabs pattern with role='tablist'
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/components/ui/page-header.tsx — PageHeader with 'Ask about this' button callback
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/components/shell/ask/command-menu.tsx — Intent router (Navigate/Search/Action/Ask) per spec §7
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/components/shell/notifications-bell.tsx — NotificationsBell component
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/components/shell/shell-frame.tsx — Topbar with org/workspace switchers and Ask bar
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/ — Knowledge section exists
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/ — Settings section exists
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/app/account/ — Account mode routes (profile, security, privacy, preferences)
- git commit d218e0a7 — housekeeping: remove Automation/Activity + all preview pages (#351) — deliberately removed sections promised in spec

**Known gaps at time of archive**

- Automation sidebar section (explicitly removed in commit d218e0a7)
- Activity sidebar section (explicitly removed in commit d218e0a7)
- Studio sidebar section (replaced by Marketplace)
- Full tab inventories for Org-level sections (Access, Security, Billing, Developer pages stripped of placeholder tabs)
- Account-mode sidebar items: Cases, Notifications (Preferences exists instead)
- Workspace-mode Knowledge tabs match spec (Repos/Nodes/Inference/Explore/Memories vs promised Sources/Graph/Memories)

**Source documents** (archived verbatim below)

- `docs/specs/application-shell/spec.md`

## Spec — `spec.md`

## Application Shell — Specification

Requirements spec for the navigation shell of the v2 app (`apps/app`). Builds on [`../information-architecture/spec.md`](../information-architecture/spec.md). This document defines **how** the IA is presented to users — not what the IA contains.

Status: **proposed**, locked by product.

---

### 1. Problem

The IA defines 11 primary surfaces × 2–6 tabs each = ~40 destinations. Dumping all of that into a single sidebar would produce a wall of links with low scanability and weak hierarchy.

Vercel, Linear, GitHub, and Google Cloud Console solve this with **two-level navigation**:

- A **sidebar** holds primary destinations (the level-1 nouns).
- A **horizontal tab bar** at the top of each page holds the sub-sections (level-2).

The sidebar answers "where am I?" The tab bar answers "what part of here?"

This spec adopts that model and adds two refinements specific to Oxagen:

1. **Three navigation modes** (Workspace / Org / Account) — the sidebar shape switches based on URL scope. You're never looking at workspace items and org items at the same time, because they're never useful at the same time.
2. **Universal Ask bar** — the central topbar control replaces command palette + search + chat-launcher into a single intent-routed input.

---

### 2. Design principles

| Principle                                    | Implication                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single source of nav truth: the URL**      | Sidebar highlighting, tab activation, mode switching, and breadcrumb state all derive from the route. No client-only nav state.                     |
| **Two levels, never three**                  | Level 1 = sidebar. Level 2 = top tabs. If a feature needs three levels, the third level is _inside the page_, not in chrome.                        |
| **Scoped sidebars**                          | Workspace mode shows workspace items only. Org mode shows org items only. Account mode shows personal items only. Switchers move you between modes. |
| **Generative > navigable for the long tail** | The static nav covers daily-use surfaces. Rare filter/list views are produced on-demand by the Ask bar and pinnable.                                |
| **Mobile is first-class, not a degradation** | Sidebar → drawer; tabs → horizontal scroll; Ask bar collapses to icon; switchers move to the drawer header.                                         |
| **One sub-nav idiom**                        | Every level-2 page uses the same horizontal tab component. No bespoke per-page tabs, accordions, or pickers in the chrome.                          |

---

### 3. Navigation modes

The shell has **three modes** keyed off the URL:

```
URL prefix                                   Mode         Sidebar shows
─────────────────────────────────────────────────────────────────────────
/account/...                                 Account      Personal items
/{orgSlug}/                                  Org          Org items
/{orgSlug}/{wsSlug}/                         Workspace    Workspace items
/(auth)/...     /(onboarding)/...            Pre-shell    No sidebar
```

Mode determines:

- Which sidebar items render
- Which switcher slots are visible in the topbar
- Which breadcrumb structure is used

Transitions between modes happen via:

- The **org switcher** (top-bar slot 2) — pick a different org, mode stays the same scope-class.
- The **workspace switcher** (slot 3) — pick a different workspace, or pick the org-root which drops you into Org mode.
- The **avatar dropdown** (slot 6) — "Account" entry drops you into Account mode.

---

### 4. Sidebar — what goes in it

#### Workspace mode (`/{org}/{ws}/...`)

```
┌──────────────────┐
│  Ask           ↗ │  ← chat front door
│  Knowledge       │
│  Automation      │
│  Activity        │
│  Studio          │  ← Tools group, visually de-emphasized
│  ─────────────   │
│  Settings        │  ← workspace settings, pinned to bottom
└──────────────────┘
```

**6 items.** Single primary group + a de-emphasized Tools row + a pinned Settings row at the bottom of the column.

#### Org mode (`/{org}/...`)

```
┌──────────────────┐
│  Workspaces    ↗ │  ← list/picker, returns you to workspace mode
│  Members         │
│  Access          │
│  Security        │
│  Billing         │
│  Developer       │
└──────────────────┘
```

**6 items.** "Workspaces" at top is the path back to workspace mode — clicking it lands on the workspace picker or the most-recent workspace.

#### Account mode (`/account/...`)

```
┌──────────────────┐
│  Back to app   ↩ │  ← returns to last workspace
│  ─────────────   │
│  Profile         │
│  Security        │
│  Cases           │
│  Notifications   │
│  Privacy         │
└──────────────────┘
```

**5 items + back link.** No sub-tabs in any account page — these are simple settings surfaces.

#### What does NOT go in the sidebar

- **Notifications** → topbar bell, drawer-based
- **Search / command** → Ask bar
- **User profile** → avatar dropdown → Account mode
- **Help & docs** → avatar dropdown
- **Theme toggle** → avatar dropdown
- **Any level-2 destination** → see §5

---

### 5. Secondary navigation — top tabs

Every level-1 destination that contains sub-sections renders them as a horizontal tab bar at the top of the page's content area. Vercel-style.

```
┌─────────────────────────────────────────────────────────────────┐
│  Org / Workspace           Ask anything…              🔔  👤    │  ← topbar
├──────────────┬──────────────────────────────────────────────────┤
│  sidebar     │  ┌──────────────────────────────────────────┐   │
│              │  │ Page header / breadcrumb                  │   │
│  Ask         │  ├──────────────────────────────────────────┤   │
│  Knowledge   │  │ Sources · Graph · Memories               │   │  ← horizontal tabs
│  Automation  │  ├──────────────────────────────────────────┤   │
│  Activity    │  │                                          │   │
│  Studio      │  │            tab content                   │   │
│  ─────       │  │                                          │   │
│  Settings    │  │                                          │   │
└──────────────┴──┴──────────────────────────────────────────────┘
```

#### Tab rules

1. **URL-addressable.** Each tab maps to a nested route (`/knowledge/sources`, not `/knowledge?tab=sources`). Deep links are bookmarkable; back-button works correctly.
2. **Active state is route-driven.** The active tab is whichever route segment matches the current URL.
3. **Default tab.** Visiting the parent route (`/knowledge`) redirects to the first tab (`/knowledge/sources`).
4. **No three-deep tabs.** If a tab needs sub-tabs, the design is wrong — restructure into the page body.
5. **Overflow.** When tabs don't fit horizontally, the tab bar becomes horizontally scrollable with edge fade indicators. Never wrap to a second row.
6. **Counts and badges allowed.** A tab can carry a badge (`Approvals (3)`). Badges are only for actionable state, never decoration.

#### Per-destination tab inventory

| Sidebar item                                                       | Tabs                                                         | Notes                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask**                                                            | none                                                         | Single-surface page (conversation list + chat panel).                                                                                                             |
| **Knowledge**                                                      | Sources · Graph · Memories                                   |                                                                                                                                                                   |
| **Automation**                                                     | Agents · Playbooks · Events · Triggers                       |                                                                                                                                                                   |
| **Activity**                                                       | Runs · Approvals · Audit                                     | `Approvals` carries a count badge.                                                                                                                                |
| **Studio**                                                         | Compose · Library                                            | History lives in Activity/Runs; Library is the gallery view.                                                                                                      |
| **Settings** (workspace)                                           | General · Members · Model Keys · Integrations                |                                                                                                                                                                   |
| **Workspaces** (org mode)                                          | none                                                         | Picker page, single surface.                                                                                                                                      |
| **Members** (org)                                                  | People · Pending · Invitations                               | `Pending` carries a count badge.                                                                                                                                  |
| **Access**                                                         | Grants · Roles · Policies · Requests · Sessions · Identities | `Requests` carries a count badge. `Identities` has internal sub-tabs (Humans · Agents · Service) rendered as **filter chips inside the tab**, not as nested tabs. |
| **Security**                                                       | SSO · SCIM · MFA · Audit · Compliance · Incidents            |                                                                                                                                                                   |
| **Billing**                                                        | Subscription · Usage · Invoices · Plans                      |                                                                                                                                                                   |
| **Developer**                                                      | MCP · Webhooks · Docs · Tokens                               |                                                                                                                                                                   |
| **Profile / Security / Cases / Notifications / Privacy** (Account) | none                                                         | Each is a single surface.                                                                                                                                         |

Total: **11 sidebar items with tabs, 4 without.** Pages average 4 tabs each.

#### Tab vs filter chips vs split layout

A short decision tree to keep idioms consistent:

- **Tabs** when sub-sections are _distinct concerns_ with their own URL (Sources is not Graph).
- **Filter chips** inside one tab when slicing the _same data_ by attribute (Identities: Humans / Agents / Service show different rows of the same principal table).
- **Split layout** (left pane list + right pane detail) when the surface is intrinsically master-detail (a Run's detail panel, a Trigger's edit form).

---

### 6. Topbar — full requirements

```
┌────────────────────────────────────────────────────────────────────┐
│  ⬡ Oxagen   [ Org ▾ ]  /  [ Workspace ▾ ]    Ask anything…   🔔 👤 │
└────────────────────────────────────────────────────────────────────┘
   1            2            3              4               5  6
```

| Slot  | Element            | Visibility                           | Behavior                                                                                                                                                                      |
| ----- | ------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Brand mark         | Always                               | Click returns to last-viewed workspace (or workspace picker if none).                                                                                                         |
| **2** | Org switcher       | Always                               | Dropdown lists all orgs the user belongs to. Footer: "New organization" link. Selecting an org navigates to `/{org}` (org mode root).                                         |
| **3** | Workspace switcher | Workspace mode only                  | Dropdown lists workspaces in the current org. Footer: "New workspace" link, "Manage workspaces" link → org-mode Workspaces. Selecting a workspace navigates to `/{org}/{ws}`. |
| **4** | Ask bar            | Always (collapses to icon at \<768px) | Universal intent input. Routes by intent — see §7.                                                                                                                            |
| **5** | Notifications bell | Always                               | Opens drawer. Badge for unread.                                                                                                                                               |
| **6** | Avatar dropdown    | Always                               | Items: Profile (→ `/account/profile`), Theme submenu, Help, Sign out.                                                                                                         |

#### Switcher specifics

The org and workspace switchers render as **breadcrumb-style chips** with a separator slash, not as siblings:

```
[ Acme Inc ▾ ] / [ Production ▾ ]
```

This signals the scope nesting visually. In Org mode the workspace chip is hidden:

```
[ Acme Inc ▾ ]
```

In Account mode both chips are hidden (the user isn't acting within an org while editing their account):

```
(only brand mark on left)
```

---

### 7. Ask bar — universal input

The Ask bar replaces command palette + search + chat launcher.

#### Intent routing

When the user types and presses Enter (or clicks a suggestion), the input is routed by intent:

| Intent       | Trigger                                                                                         | Behavior                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Navigate** | Input matches a known route or destination name (`go to billing`, `members`, `knowledge graph`) | Push the route.                                                                          |
| **Search**   | Input matches an entity prefix (`run #4221`, `playbook churn-`, `@alice@acme.com`)              | Open inline result list. Selecting an item pushes the route.                             |
| **Action**   | Input matches a capability trigger (`create trigger`, `invite alice@…`, `revoke token tk_abc`)  | Open the action UI pre-filled. The action runs through the contract check, audit logged. |
| **Ask**      | Default / question-shaped input (`why did this run fail?`, `what's our churn rate?`)            | Opens the Ask drawer with the current page entity as context.                            |

Routing is determined client-side by lightweight pattern matching plus a server-side LLM fallback when client patterns don't match.

#### Keyboard shortcut

`/` focuses the Ask bar from anywhere (matching GitHub / Linear convention). `Esc` clears and returns focus. `Cmd-K` (`Ctrl-K` on Windows/Linux) opens the bar in expanded mode showing recent activity and suggestions.

#### Ask drawer

When the intent resolves to **Ask**, the right-side drawer opens with chat. The drawer:

- 480px wide on desktop, full-width on mobile
- Persists across page navigation within a session (you can open it on Runs, navigate to Playbooks, the drawer is still there)
- Auto-attaches the current page's primary entity as chat context (e.g., on a Run page, the Run ID is in the chat scope)
- Has a "pop out" button → routes to `/ask` with the conversation preserved

---

### 8. Page-level Ask affordance

Every detail page (a Run, a Playbook, a Trigger, an OntologyNode, etc.) renders an **"Ask about this"** button in the page header. Clicking it opens the Ask drawer pre-loaded with that entity. This is how chat becomes ambient — it's never more than one click from any object.

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Triggers / churn-investigate           Ask about this   ⋯   │  ← page header
├─────────────────────────────────────────────────────────────────┤
```

---

### 9. Mobile behavior

Breakpoints aligned to Tailwind defaults:

| Breakpoint        | Sidebar                                           | Tabs                         | Topbar                               |
| ----------------- | ------------------------------------------------- | ---------------------------- | ------------------------------------ |
| `lg` (≥1024px)    | Persistent column, 240px                          | Horizontal row               | Full layout                          |
| `md` (768–1023px) | Persistent narrow rail (icons only, hover-expand) | Horizontal scroll            | Ask bar full width                   |
| `<md`             | Off-canvas drawer (hamburger)                     | Horizontal scroll, edge-fade | Brand + Org chip + Ask icon + avatar |

On `<md`:

- Sidebar drawer header contains the switchers (so they're still reachable).
- The Ask bar collapses to an icon; tapping opens a full-sheet input.
- Tab bars become horizontally scroll-snapped.

---

### 10. State management

#### Source of truth

| State                                    | Source                                                          |
| ---------------------------------------- | --------------------------------------------------------------- |
| Current mode (workspace / org / account) | URL prefix                                                      |
| Active sidebar item                      | URL segment                                                     |
| Active tab                               | URL segment                                                     |
| Switcher selections                      | URL params (org slug, workspace slug)                           |
| Ask drawer open/closed                   | `?ask=open` query param OR ephemeral client state — TBD in plan |
| Sidebar collapsed/expanded (on `md`)     | `localStorage`, per device                                      |
| Last-viewed workspace per org            | `localStorage`, used by org switcher and brand-mark click       |

#### Loading / suspense

- Sidebar items are rendered server-side from the session — no skeleton needed; the shell is ready before content.
- Tab bars render immediately; tab _content_ uses Suspense with a skeleton sized to the tab's typical layout.
- Switcher dropdowns lazy-load their data on open.

---

### 11. Accessibility requirements

- **Sidebar**: `<nav aria-label="Primary">`. Items are `<a>` with `aria-current="page"` for the active item.
- **Tabs**: WAI-ARIA tabs pattern. `role="tablist"`, `role="tab"`, `role="tabpanel"`. Arrow keys move focus between tabs. Enter activates and navigates.
- **Switchers**: `<button aria-haspopup="menu">`. Menu items are keyboard navigable; first character jumps to matching entry.
- **Ask bar**: `<input>` with descriptive `aria-label`. Suggestions list uses combobox pattern (`role="combobox"`, `aria-controls`, `aria-activedescendant`).
- **Skip link** at the top of every page: "Skip to content" → focuses `<main>`.
- **Color contrast**: all chrome elements ≥ 4.5:1 against background; active states ≥ 7:1.
- **Reduced motion**: `prefers-reduced-motion` disables drawer slide animations.

---

### 12. Performance budgets

| Asset                                                     | Budget                                                 |
| --------------------------------------------------------- | ------------------------------------------------------ |
| Initial shell render (TTFB → first paint)                 | ≤ 200ms on mid-tier laptop, ≤ 500ms on mid-tier mobile |
| Sidebar + topbar JS bundle (gzipped)                      | ≤ 35KB                                                 |
| Switcher dropdown open → interactive                      | ≤ 100ms                                                |
| Tab click → new tab content visible (no skeleton overlap) | ≤ 150ms                                                |
| Ask drawer open animation                                 | 200ms, single composited transform                     |

Server-rendered shell. No client-side route guards.

---

### 13. Theming & visual treatment

Inherits all design tokens from `@oxagen/ui/styles/tokens.css` (per IA spec §13). Notable shell-specific rules:

- **Sidebar background**: `--color-card` (lighter than main bg) on light, `--color-card` on dark.
- **Active item indicator**: 3px left bar in `--color-accent`, plus muted background. No filled bar that covers full item.
- **Tab indicator**: 2px bottom border in `--color-accent` on active. Inactive tabs are `--color-muted-foreground` text.
- **Tools group label**: smaller, muted, uppercase tracking-wide — same treatment as the existing "Workspace" / "Organization" section labels.
- **Switchers**: glass background (`.glass` utility from the shared package) to differentiate from sidebar items.
- **Dark/light parity**: every state has both. Tested at both.

---

### 14. Component inventory

Concrete React components the shell needs. Lives in `apps/app/src/components/shell/` (existing folder) and the shared `@oxagen/ui` for any reusable primitives.

| Component           | Location     | Notes                                                             |
| ------------------- | ------------ | ----------------------------------------------------------------- |
| `AppShell`          | `apps/app`   | Mode-aware layout root. Reads URL, picks sidebar config, renders. |
| `Topbar`            | `apps/app`   | Brand + switchers + Ask + bell + avatar.                          |
| `OrgSwitcher`       | `apps/app`   | Already exists as `TenantSwitcher`; rename.                       |
| `WorkspaceSwitcher` | `apps/app`   | Exists. Add "Manage workspaces" footer link.                      |
| `Sidebar`           | `apps/app`   | Mode-aware. Reads sidebar config for current mode.                |
| `SidebarItem`       | `@oxagen/ui` | Reusable. Active state, badge, icon, optional ↗/↩ indicator.      |
| `AskBar`            | `apps/app`   | New. Intent router + suggestion list.                             |
| `AskDrawer`         | `apps/app`   | New. Wraps existing `ChatShellClient`.                            |
| `NotificationsBell` | `apps/app`   | New. Drawer-based.                                                |
| `AvatarMenu`        | `apps/app`   | New. Dropdown with Profile / Theme / Help / Sign out.             |
| `PageTabs`          | `@oxagen/ui` | Reusable. WAI-ARIA tabs, URL-driven active state.                 |
| `PageHeader`        | `@oxagen/ui` | Title + breadcrumb + actions slot + "Ask about this" affordance.  |
| `Breadcrumb`        | `@oxagen/ui` | Reusable. Reads from a route → label config.                      |

#### Sidebar config shape

The sidebar definition is data, not JSX. Stored as a typed config so it can be:

- Rendered by the sidebar component
- Walked by the Ask bar for navigation intents
- Audited (every nav surface is enumerable)

```ts
type SidebarMode = "workspace" | "org" | "account";

type SidebarItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  href: (ctx: ScopeContext) => string; // computes /{org}/{ws}/... etc
  group?: "primary" | "tools" | "footer"; // visual grouping
  badge?: (ctx: ScopeContext) => number | null;
  external?: boolean; // shows ↗
  isReturn?: boolean; // shows ↩ — for the "Back to app" item
};

type SidebarConfig = {
  mode: SidebarMode;
  items: SidebarItem[];
};
```

A single registry in `apps/app/src/lib/sidebar.ts` holds all three configs. The `AppShell` picks one based on mode.

---

### 15. Edge cases

| Case                                         | Behavior                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| User signs in but has no org                 | Onboarding flow (`/(onboarding)/new-organization`). No shell.                                                                                     |
| Org exists but no workspaces                 | Org mode. Sidebar shows org items. The "Workspaces" item shows an empty state with a "New workspace" CTA.                                         |
| User is Owner of zero orgs and Member of one | Org switcher renders, but "New organization" link is disabled with tooltip explaining seat policy. (Configurable per billing tier.)               |
| Workspace deleted while user is viewing it   | Page returns 404; shell catches and redirects to workspace picker. Toast: "Workspace was deleted."                                                |
| Permission denied on a level-1 destination   | Sidebar item is hidden (not greyed). Direct URL access shows a 403 page with an "Ask for access" button (routes to `/{org}/access/requests/new`). |
| Permission denied on a tab                   | Tab is hidden from the tab bar. Direct URL shows 403 inside the tab content area, with the rest of the tab bar still functional.                  |

Hiding-vs-disabling permission UI: **hide for navigation, show 403 with context for deep links.** This avoids exposing the org's capability structure to under-privileged users.

---

### 16. Non-goals (for v2 launch)

- Customizable / drag-to-reorder sidebar.
- User-pinned tabs in the page header.
- Multiple simultaneous Ask drawers.
- A "recently visited" surface.
- Sidebar collapse-to-icons that's user-configurable on `lg`.

These are deferrable; the shell shape is the priority.

---

### 17. Validation criteria

The shell is ready to ship when:

- [ ] All three modes render with correct sidebar content driven by URL.
- [ ] Every tab in §5 is a working route with a real page (stubs OK for non-MVP features).
- [ ] Org and Workspace switchers function and navigate correctly.
- [ ] Ask bar handles all four intents (Navigate, Search, Action, Ask).
- [ ] Ask drawer opens / persists across navigation / pops out to `/ask`.
- [ ] Mobile breakpoints all render correctly (Lighthouse mobile pass).
- [ ] WAI-ARIA tabs pattern verified with screen reader.
- [ ] Active states are URL-driven (refresh → correct highlight without client-side state).
- [ ] Permission-denied surfaces hide-then-403 per §15.
- [ ] Performance budgets in §12 are met (Lighthouse + Vercel Analytics confirmation).

---

### 18. Changelog

- 2026-05-29 — Initial specification.

