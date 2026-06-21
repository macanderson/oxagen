# Installable Plugins — Plan 6: UI (org plugins settings + marketplace modal + workspace install + re-auth page)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every user-facing surface for installable plugins — the org Plugins settings page, the marketplace modal, the workspace install/integrations surface, the re-auth deep-link page, and the org alert-settings toggle — wiring each to the capabilities already shipped in Plans 2–5.

**Architecture:** All mutation surfaces are server actions that mirror the `billing/actions.ts` pattern exactly: `getSessionOrRedirect` → `resolveOrg`/`resolveWorkspace` → `assertMcpManager` → `buildCtx` → `invoke(cap.name, input, ctx, { surface: "agent" })`. Read surfaces are Next.js server components calling capabilities through `invoke()` inside `runInTenantScope`. Client components use coss (`@oxagen/ui`) — `Dialog`/`DialogPopup` for the marketplace modal, `Tabs`/`TabsList`/`TabsTab`/`TabsPanel` for type tabs, `Switch` for toggles, `Badge` for transport/auth labels — following the `render`-not-`asChild` and `data-[checked]`/`data-[selected]` conventions enforced by Base UI.

**Tech Stack:** Next.js App Router RSC + server actions; `invoke` from `@oxagen/oxagen`; `@oxagen/handlers/register` side-effect import; `@oxagen/ui` coss components (`Dialog`, `Tabs`, `Switch`, `Badge`, `Button`, `Input`); `@oxagen/oxagen` contracts (`plugin.catalog.browse`, `plugin.catalog.get`, `plugin.org.install`, `plugin.org.install_bulk`, `plugin.org.uninstall`, `plugin.org.set_enabled`, `plugin.denylist.add`, `plugin.denylist.remove`, `plugin.registry.list`, `plugin.registry.add`, `plugin.registry.remove`, `plugin.workspace.set_enabled`, `plugin.credential.set_secret`); `revalidatePath`; Tailwind CSS (no glass/translucency).

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§10 UI)

---

## Context you must read before coding

### Server-action pattern (canonical — mirror exactly)

File: `apps/app/src/app/[orgSlug]/members/member-actions.ts`

Every plugin server action follows this five-step pattern:

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";               // REQUIRED side-effect import — no handler resolves without it
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

function buildCtx(opts: { orgId: string; workspaceId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

export async function somePluginAction(input: { orgSlug: string; ... }): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SomeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const org = await resolveOrg(parsed.data.orgSlug);
  await assertOrgMember(org.id, session.user.id);    // IDOR pre-check (membership)

  // For org-level plugin mutations: use assertMcpManager (added in Task A)
  // For workspace-level: also resolveWorkspace + org-role gate in ctx

  const ctx = buildCtx({ orgId: org.id, workspaceId: "", userId: session.user.id });
  try {
    await invoke("plugin.org.install", { ... }, ctx, { surface: "agent" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed" };
  }
  revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
  return { ok: true };
}
```

**Org-only context:** set `workspaceId: ""` for org-scoped plugin capabilities (no sentinel needed — the capability handler sets the scope). For workspace-scoped capabilities (`plugin.workspace.set_enabled`, `plugin.credential.set_secret`), resolve and pass the real `workspaceId`.

**VERIFY:** Check `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/models/models-action.ts` for the workspace-scoped variant (uses `resolveWorkspace`, passes real `ws.id` to `buildCtx`, wraps in `runInTenantScope`).

### coss/`@oxagen/ui` conventions

From `packages/ui/src/components/`:

- **Dialog:** `<Dialog open onOpenChange>` → `<DialogPopup className="max-w-5xl">` → `<DialogHeader>` + `<DialogPanel>` + `<DialogFooter>`. No `asChild`. Close button is built into `DialogPopup`.
- **Tabs:** `<Tabs defaultValue>` → `<TabsList variant="underline">` → `<TabsTab value>` (NOT `TabsTrigger`) → `<TabsPanel value>` (NOT `TabsContent`). Active state via `data-[selected]`, not `data-[state=active]`.
- **Switch:** `<Switch checked={...} onCheckedChange={...} />`. On-state: `data-[checked]`.
- **Badge:** `<Badge variant="outline" size="sm">` — no `render` prop needed for static labels. Transport/auth kind badges use `variant="muted"`.
- **Button:** standard `<Button variant size>`. Default is `variant="default"` (primary color).
- **Input:** `<Input type="text" value onChange />` — controlled.
- No glass/translucency anywhere. Use `border border-border/60 bg-muted/60` for card surfaces.

### Capability output shapes (reference)

- `plugin.catalog.browse` → `{ servers: Array<{ id, name, title, description, icons, transportTypes, authKind, categories, version }>, nextOffset, total }`
- `plugin.catalog.get` → `{ id, name, title, description, version, websiteUrl, icons, packages, remotes, transportTypes, authKind, categories, readmeHtml, status }`
- `plugin.org.install` → `{ orgListingId }`
- `plugin.org.install_bulk` → `{ installed: Array<{ catalogServerId, orgListingId, error }> }`
- `plugin.org.set_enabled` → `{ ok }`
- `plugin.org.uninstall` → `{ ok }`
- `plugin.registry.list` → `{ registries: Array<{ id, name, baseUrl, enabled, isDefaultSeed, lastSyncedAt }> }`
- `plugin.workspace.set_enabled` → `{ workspaceServerId }`

### Missing contracts (not yet shipped — note in plan, tasks handle gracefully)

The spec lists `plugin.credential.reauth`, `notifications.list`, `notifications.mark`, and `plugin.settings.set_auth_alerts` — these contracts are NOT in `packages/oxagen/src/contracts/` yet (scheduled for Plans 5 and later). Tasks that call them add `// VERIFY: contract ships in Plan 5` comments and wrap calls in `try/catch`. Do not block on absent contracts — implement the UI shell and wire it when the contract lands.

---

## Task A — `assertMcpManager` + `resolveManagedOrgForPlugins`

**Status: CONFIRMED MISSING.** Only `assertBillingManager` (`BILLING_MANAGER_ROLES = { owner, admin, billing }`) exists in `apps/app/src/lib/resolve-org.ts`. The spec (§8) explicitly requires `assertMcpManager` — a direct clone with role set `{ owner, admin }`.

- [ ] **A1** — Add `assertMcpManager` to `apps/app/src/lib/resolve-org.ts`

**Files:**
- `apps/app/src/lib/resolve-org.ts` (edit — add after `assertBillingManager`)

```ts
/** Roles permitted to manage plugins (MCP servers, integrations, content tools). */
const MCP_MANAGER_ROLES = new Set(["owner", "admin"]);

/**
 * Assert that the user is a member of the org AND holds a plugin-management
 * role (owner/admin). Calls `notFound()` otherwise — consistent with
 * {@link assertBillingManager}. Use in any server route/action that mutates
 * org plugin governance (install, uninstall, denylist, registry, enable/disable).
 */
export const assertMcpManager = cache(
  async (orgId: string, userId: string): Promise<void> => {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            eq(schema.orgUsers.userId, userId),
          ),
        )
        .limit(1),
    );
    const role = rows[0]?.role;
    if (!role || !MCP_MANAGER_ROLES.has(role)) {
      notFound();
    }
  },
);
```

- [ ] **A2** — Add `resolveManagedOrgForPlugins` helper for server actions

This mirrors `resolveManagedOrg` in `billing/actions.ts` but uses owner/admin gate and emits a `plugin.access_denied` security event.

**Files:**
- `apps/app/src/app/[orgSlug]/settings/plugins/plugin-actions.ts` (new file — created in Task B, but the helper is defined here so all plugin actions can import it)

The helper returns `{ orgId: string; actorUserId: string } | null`.

```ts
// Inside plugin-actions.ts (see Task B for full file)
const CAN_MANAGE_PLUGINS = new Set(["owner", "admin"]);
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

async function resolveManagedOrgForPlugins(
  orgSlug: string,
): Promise<{ orgId: string; actorUserId: string } | null> {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(orgSlug);
  if (!session.user) return null;

  const { withTenantDb, schema } = await import("@oxagen/database");
  const { eq, and } = await import("drizzle-orm");
  const [row] = await runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, tenant.id),
            eq(schema.orgUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    ),
  );
  const role = row?.role ?? null;
  if (!role || !CAN_MANAGE_PLUGINS.has(role)) {
    logger.warn({ orgSlug, userId: session.user.id, role }, "plugin: action denied — not a plugin manager");
    return null;
  }
  return { orgId: tenant.id, actorUserId: session.user.id };
}
```

**Commit:** `feat(app): add assertMcpManager + resolveManagedOrgForPlugins to resolve-org`

---

## Task B — Org settings → Plugins page + server actions

New route: `apps/app/src/app/[orgSlug]/settings/plugins/`

Sections:
1. **Registries** — list org registries (incl. seeded default shown read-only), add custom, remove non-seed.
2. **Org allow-list** — table of installed plugins: name, type, enabled toggle, uninstall.
3. **Custom plugin form** — add a custom MCP server (name, title, endpoint URL, transport, auth kind).
4. **Denylist manager** — list denied server names, add, remove.
5. **"Browse marketplace" button** — opens the marketplace modal (Task C).

The org settings layout (`apps/app/src/app/[orgSlug]/settings/`) currently has no `layout.tsx` — it relies on the parent `[orgSlug]/layout.tsx`. The `settings/general` link already works. This plan **adds a "Plugins" tab** by adding `apps/app/src/app/[orgSlug]/settings/layout.tsx` (new file) and extending `apps/app/src/lib/routes.ts` with `org.settings.plugins`.

- [ ] **B1** — Extend `routes.ts`: add `org.settings.plugins`

**Files:** `apps/app/src/lib/routes.ts`

```ts
// Inside the `org.settings` object (after `general`):
plugins: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/plugins`,
```

- [ ] **B2** — Create org settings layout with General + Plugins tabs

**Files:** `apps/app/src/app/[orgSlug]/settings/layout.tsx` (new)

```tsx
import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { org } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function OrgSettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx: ScopeContext = { orgSlug };

  const tabs = [
    { label: "General", href: org.settings.general(ctx) },
    { label: "Plugins", href: org.settings.plugins(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Organization Settings"
        description="Configure your organization, manage plugins, and govern third-party integrations."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
```

**VERIFY:** Check `apps/app/src/components/ui/page-header.tsx` and `apps/app/src/components/ui/page-tabs.tsx` for exact props before coding — mirror the billing layout which uses the same two components.

- [ ] **B3** — Create `plugin-actions.ts` server actions file

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/plugin-actions.ts` (new)

This is the canonical server actions module for all org-level plugin mutations. Include `resolveManagedOrgForPlugins` (from Task A2), then export these actions:

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

// ... resolveManagedOrgForPlugins (from Task A2) ...

const NOT_AUTHORIZED = "You don't have permission to manage plugins for this organization.";
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

function buildCtx(opts: { orgId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: "",
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

// ── installPluginAction ───────────────────────────────────────────────────────
const InstallSchema = z.object({
  orgSlug: z.string().min(1),
  catalogServerId: z.string().optional(),
  pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
  custom: z.object({
    name: z.string().min(1).max(120),
    title: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    endpointUrl: z.string().url(),
    transport: z.string().min(1),
    authKind: z.enum(["oauth", "secret", "none"]),
  }).optional(),
});

export async function installPluginAction(
  input: z.infer<typeof InstallSchema>,
): Promise<{ ok: boolean; orgListingId?: string; error?: string }> {
  const parsed = InstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke(
      "plugin.org.install",
      { pluginType: parsed.data.pluginType, catalogServerId: parsed.data.catalogServerId, custom: parsed.data.custom },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true, orgListingId: out.orgListingId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Install failed" };
  }
}

// ── installBulkPluginAction ───────────────────────────────────────────────────
const InstallBulkSchema = z.object({
  orgSlug: z.string().min(1),
  items: z.array(z.object({
    catalogServerId: z.string().optional(),
    pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
  })).min(1).max(50),
});

export async function installBulkPluginAction(
  input: z.infer<typeof InstallBulkSchema>,
): Promise<{ ok: boolean; installed?: Array<{ catalogServerId: string | null; orgListingId: string | null; error: string | null }>; error?: string }> {
  const parsed = InstallBulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke("plugin.org.install_bulk", { items: parsed.data.items }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true, installed: out.installed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Bulk install failed" };
  }
}

// ── setOrgPluginEnabledAction ─────────────────────────────────────────────────
const SetEnabledSchema = z.object({
  orgSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  enabled: z.boolean(),
});

export async function setOrgPluginEnabledAction(
  input: z.infer<typeof SetEnabledSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = SetEnabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.org.set_enabled", { orgListingId: parsed.data.orgListingId, enabled: parsed.data.enabled }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Update failed" };
  }
}

// ── uninstallPluginAction ─────────────────────────────────────────────────────
const UninstallSchema = z.object({
  orgSlug: z.string().min(1),
  orgListingId: z.string().min(1),
});

export async function uninstallPluginAction(
  input: z.infer<typeof UninstallSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = UninstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.org.uninstall", { orgListingId: parsed.data.orgListingId }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Uninstall failed" };
  }
}

// ── addDenylistAction ─────────────────────────────────────────────────────────
const DenylistAddSchema = z.object({
  orgSlug: z.string().min(1),
  serverName: z.string().min(1),
  pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
  reason: z.string().max(500).optional(),
});

export async function addDenylistAction(
  input: z.infer<typeof DenylistAddSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = DenylistAddSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.denylist.add", { serverName: parsed.data.serverName, pluginType: parsed.data.pluginType, reason: parsed.data.reason }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Denylist add failed" };
  }
}

// ── removeDenylistAction ──────────────────────────────────────────────────────
const DenylistRemoveSchema = z.object({
  orgSlug: z.string().min(1),
  serverName: z.string().min(1),
  pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
});

export async function removeDenylistAction(
  input: z.infer<typeof DenylistRemoveSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = DenylistRemoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.denylist.remove", { serverName: parsed.data.serverName, pluginType: parsed.data.pluginType }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Denylist remove failed" };
  }
}

// ── addRegistryAction ─────────────────────────────────────────────────────────
const AddRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
});

export async function addRegistryAction(
  input: z.infer<typeof AddRegistrySchema>,
): Promise<{ ok: boolean; registryId?: string; error?: string }> {
  const parsed = AddRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke("plugin.registry.add", { name: parsed.data.name, baseUrl: parsed.data.baseUrl }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true, registryId: out.registryId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Registry add failed" };
  }
}

// ── removeRegistryAction ──────────────────────────────────────────────────────
const RemoveRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  registryId: z.string().min(1),
});

export async function removeRegistryAction(
  input: z.infer<typeof RemoveRegistrySchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = RemoveRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.registry.remove", { registryId: parsed.data.registryId }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Registry remove failed" };
  }
}
```

- [ ] **B4** — Create the org Plugins page server component

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` (new)

Data fetched server-side: viewer role (for `canManage`), registries list, org listings (allow-list), denylist. Use `invoke()` inside `runInTenantScope` with ORG_ONLY_WS sentinel.

```tsx
import { eq, and } from "drizzle-orm";
import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { OrgPluginsPanel } from "./org-plugins-panel";
import {
  installPluginAction,
  installBulkPluginAction,
  setOrgPluginEnabledAction,
  uninstallPluginAction,
  addDenylistAction,
  removeDenylistAction,
  addRegistryAction,
  removeRegistryAction,
} from "./plugin-actions";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export const dynamic = "force-dynamic";

export default async function OrgPluginsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);

  // Read viewer role (same pattern as billing/subscription/page.tsx)
  const [viewerRoleRow] = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, org.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );

  const viewerRole = viewerRoleRow?.role ?? "member";
  const canManage = ["owner", "admin"].includes(viewerRole.toLowerCase());

  const ctx = {
    orgId: org.id,
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  // Fetch registries and org listings in parallel
  const [registriesResult, /* listings from DB via capability */] = await Promise.all([
    invoke("plugin.registry.list", {}, ctx, { surface: "agent" }).catch(() => ({ registries: [] })),
  ]);

  // VERIFY: plugin.org.list capability (may not exist yet — Plans 2/3 ship plugin.org.install
  // but not a browse-by-org listing capability). If absent, read from DB directly using
  // withTenantDb + schema.pluginOrgListings. Fall back gracefully with empty array.
  // TODO: once plugin.org.list is shipped, replace the direct DB read below.
  const listings = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgListings)
        .where(eq(schema.pluginOrgListings.orgId, org.id))
        .orderBy(schema.pluginOrgListings.name),
    ),
  ).catch(() => []);

  // VERIFY: schema.pluginOrgListings — check packages/database/src/schema/ for exact name.
  // If the table is named differently (e.g. orgListings, pluginListings), adjust accordingly.

  const denylisted = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgDenylist)
        .where(eq(schema.pluginOrgDenylist.orgId, org.id))
        .orderBy(schema.pluginOrgDenylist.serverName),
    ),
  ).catch(() => []);

  // VERIFY: schema.pluginOrgDenylist — check packages/database/src/schema/ for exact name.

  return (
    <OrgPluginsPanel
      orgSlug={orgSlug}
      canManage={canManage}
      registries={registriesResult.registries}
      listings={listings}
      denylisted={denylisted}
      installAction={installPluginAction}
      installBulkAction={installBulkPluginAction}
      setEnabledAction={setOrgPluginEnabledAction}
      uninstallAction={uninstallPluginAction}
      addDenylistAction={addDenylistAction}
      removeDenylistAction={removeDenylistAction}
      addRegistryAction={addRegistryAction}
      removeRegistryAction={removeRegistryAction}
    />
  );
}
```

- [ ] **B5** — Create `OrgPluginsPanel` client component

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/org-plugins-panel.tsx` (new)

This client component renders all four sections. It is "use client" and receives all server actions as props (same pattern as `OrgGeneralForm` which receives `action` as a prop). Sections are rendered as collapsible cards using `border border-border/60 rounded-xl` containers (no glass/translucency per CLAUDE.md rule).

Key behaviors:
- **Registries section:** Table with name, URL, enabled indicator, last synced. Default seed row is locked (no remove button; "Default" badge). Add-registry form is collapsed by default, toggled by "Add registry" button.
- **Allow-list section:** Table with plugin icon (first `icons[0].src` hotlinked via `<img>`, fallback to a generic puzzle-piece SVG), name/title, type badge, transport badge, auth-kind badge, enabled `Switch`, "Uninstall" button (with `window.confirm` guard). "Browse marketplace" button opens the `MarketplaceModal` (Task C).
- **Custom plugin form:** Collapsed; add button expands a form with fields: Name, Title (optional), Endpoint URL, Transport (streamable-http / sse), Auth Kind (none / secret / oauth). On submit → `installAction` with `custom` field set.
- **Denylist section:** List of denied server names with type and reason (truncated). Add-denylist form: server name text input + optional reason + plugin type select. Remove buttons per row.

```tsx
"use client";
import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { MarketplaceModal } from "@/components/plugins/marketplace-modal";
import { ShoppingBag, Trash2, Plus, RefreshCw } from "lucide-react";
// ... full implementation per section above
```

**VERIFY:** Import paths for `Label` — check `apps/app/src/components/ui/label.tsx` exists (it does per the file listing).

**Important implementation notes:**
- Every server action call is wrapped in `startTransition` + local `isPending` state for optimistic loading feedback.
- Error messages from actions are shown inline below the relevant section in a `<p className="text-sm text-destructive">`.
- Type badge colors: `mcp_server` → `variant="outline"`, `integration` → `variant="muted"`, `content_tool` → `variant="secondary"`.
- Auth badge colors: `oauth` → `variant="info"`, `secret` → `variant="warning"`, `none` → `variant="muted"`.
- Transport badges: `variant="outline" size="sm"`.

**Commit:** `feat(app): org plugins settings page — registries, allow-list, denylist, custom-server form`

---

## Task C — Marketplace modal

**Files:**
- `apps/app/src/components/plugins/marketplace-modal.tsx` (new)
- `apps/app/src/components/plugins/plugin-detail-panel.tsx` (new)

The marketplace modal is triggered from the OrgPluginsPanel "Browse marketplace" button and from the workspace integrations page. It is a controlled `Dialog` (`open`/`onOpenChange` props) with `DialogPopup` set to `max-w-5xl` and a fixed height (`h-[80vh]`).

- [ ] **C1** — Create `MarketplaceModal` component

**Files:** `apps/app/src/components/plugins/marketplace-modal.tsx` (new)

```tsx
"use client";
import * as React from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PluginDetailPanel } from "./plugin-detail-panel";
import { Search, Package, Plug, FileText, ShoppingBag } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogServer {
  id: string;
  name: string;
  title: string | null;
  description: string;
  icons: Array<{ src: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  version: string;
}

interface MarketplaceModalProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deny-listed server names (for greying out) */
  deniedNames?: string[];
  /** Server action: install single plugin */
  installAction: (input: {
    orgSlug: string;
    catalogServerId: string;
    pluginType: "mcp_server" | "integration" | "content_tool";
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  /** Server action: bulk install */
  installBulkAction: (input: {
    orgSlug: string;
    items: Array<{ catalogServerId: string; pluginType: "mcp_server" | "integration" | "content_tool" }>;
  }) => Promise<{ ok: boolean; error?: string }>;
}

const PLUGIN_TABS = [
  { value: "mcp_server", label: "MCP Servers", icon: Plug },
  { value: "integration", label: "Integrations", icon: Package },
  { value: "content_tool", label: "Content Tools", icon: FileText },
] as const;

type PluginTypeValue = "mcp_server" | "integration" | "content_tool";

// ── Component ─────────────────────────────────────────────────────────────────

export function MarketplaceModal({
  orgSlug,
  open,
  onOpenChange,
  deniedNames = [],
  installAction,
  installBulkAction,
}: MarketplaceModalProps) {
  const [activeTab, setActiveTab] = React.useState<PluginTypeValue>("mcp_server");
  const [search, setSearch] = React.useState("");
  const [authFilter, setAuthFilter] = React.useState<"" | "oauth" | "secret" | "none">("");
  const [servers, setServers] = React.useState<CatalogServer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [bulkPending, setBulkPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch catalog via the API route (GET /api/v1/plugin/catalog/browse)
  // The marketplace calls the API rather than a direct server action so the
  // modal can re-fetch on tab/filter change without triggering a full server
  // component re-render. The API route calls invoke() server-side.
  const fetchServers = React.useCallback(
    async (offset = 0, replace = true) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          limit: "30",
          offset: String(offset),
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(authFilter ? { authKind: authFilter } : {}),
        });
        const res = await fetch(`/api/v1/plugin/catalog/browse?${params.toString()}`);
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          servers: CatalogServer[];
          nextOffset: number | null;
          total: number;
        };
        setServers((prev) => (replace ? data.servers : [...prev, ...data.servers]));
        setNextOffset(data.nextOffset);
        setTotal(data.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load catalog");
      } finally {
        setLoading(false);
      }
    },
    [search, authFilter],
  );

  // Re-fetch when the modal opens or filters change
  React.useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setDetailId(null);
    fetchServers(0, true);
  }, [open, activeTab, search, authFilter, fetchServers]);

  // Debounce search input
  const searchTimeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = (val: string) => {
    setSearch(val);
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => fetchServers(0, true), 300);
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const handleBulkInstall = async () => {
    if (selected.size === 0) return;
    setBulkPending(true);
    setError(null);
    try {
      const result = await installBulkAction({
        orgSlug,
        items: Array.from(selected).map((id) => ({ catalogServerId: id, pluginType: activeTab })),
      });
      if (!result.ok) { setError(result.error ?? "Bulk install failed"); return; }
      setSelected(new Set());
      onOpenChange(false);
    } finally {
      setBulkPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-5xl h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <ShoppingBag className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Plugin Marketplace
          </DialogTitle>
          <DialogDescription>
            Browse and install MCP servers, integrations, and content tools for your organization.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => { setActiveTab(v as PluginTypeValue); setSelected(new Set()); }}
          className="flex flex-col flex-1 min-h-0"
        >
          {/* Tab bar + search row */}
          <div className="flex-shrink-0 px-6 pt-3 pb-0 border-b border-border/40">
            <div className="flex items-center justify-between gap-4">
              <TabsList variant="underline" className="gap-6">
                {PLUGIN_TABS.map(({ value, label, icon: Icon }) => (
                  <TabsTab key={value} value={value} className="flex items-center gap-1.5 text-sm">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </TabsTab>
                ))}
              </TabsList>

              <div className="flex items-center gap-2">
                {/* Auth filter chips */}
                {(["", "oauth", "secret", "none"] as const).map((k) => (
                  <button
                    key={k || "all"}
                    type="button"
                    onClick={() => setAuthFilter(k)}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                      authFilter === k
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border/60 text-muted-foreground hover:border-foreground/40"
                    }`}
                  >
                    {k === "" ? "All" : k}
                  </button>
                ))}
                <div className="relative ml-2">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <Input
                    type="search"
                    placeholder="Search…"
                    size="sm"
                    className="pl-7 w-52"
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Content panels */}
          {PLUGIN_TABS.map(({ value }) => (
            <TabsPanel key={value} value={value} className="flex-1 min-h-0 overflow-auto mt-0">
              <div className="flex h-full">
                {/* Server grid */}
                <div className={`flex-1 overflow-auto p-6 ${detailId ? "w-1/2 border-r border-border/40" : "w-full"}`}>
                  {error && (
                    <p className="mb-4 text-sm text-destructive">{error}</p>
                  )}
                  {loading && servers.length === 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-28 rounded-xl border border-border/40 bg-muted/30 animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <>
                      <p className="mb-3 text-xs text-muted-foreground">{total} servers</p>
                      <div className="grid grid-cols-2 gap-3">
                        {servers.map((srv) => {
                          const denied = deniedNames.includes(srv.name);
                          const isSelected = selected.has(srv.id);
                          return (
                            <button
                              key={srv.id}
                              type="button"
                              onClick={() => { if (!denied) setDetailId(srv.id); }}
                              disabled={denied}
                              className={`relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${
                                denied
                                  ? "border-border/30 bg-muted/20 opacity-50 cursor-not-allowed"
                                  : isSelected
                                  ? "border-primary/60 bg-primary/5"
                                  : "border-border/60 bg-card hover:border-foreground/30 hover:bg-muted/30"
                              }`}
                              aria-label={denied ? `${srv.title ?? srv.name} — blocked by your organization's admins` : srv.title ?? srv.name}
                            >
                              {/* Multi-select checkbox — native input, styled with Tailwind */}
                              {!denied && (
                                <span
                                  className="absolute top-3 right-3"
                                  onClick={(e) => { e.stopPropagation(); toggleSelect(srv.id); }}
                                  aria-label={isSelected ? "Deselect" : "Select"}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelect(srv.id)}
                                    className="h-4 w-4 rounded border-border accent-primary"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                </span>
                              )}

                              <div className="flex items-start gap-2 pr-6">
                                {srv.icons[0] ? (
                                  <img src={srv.icons[0].src} alt="" className="h-8 w-8 rounded object-contain flex-shrink-0" aria-hidden="true" />
                                ) : (
                                  <span className="flex h-8 w-8 items-center justify-center rounded bg-muted flex-shrink-0">
                                    <Plug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                  </span>
                                )}
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium leading-tight">{srv.title ?? srv.name}</p>
                                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{srv.description}</p>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-1">
                                {srv.transportTypes.slice(0, 2).map((t) => (
                                  <Badge key={t} variant="outline" size="sm">{t}</Badge>
                                ))}
                                <Badge variant={srv.authKind === "oauth" ? "info" : srv.authKind === "secret" ? "warning" : "muted"} size="sm">
                                  {srv.authKind}
                                </Badge>
                              </div>

                              {denied && (
                                <p className="text-xs text-muted-foreground italic">Blocked by your organization&apos;s admins</p>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {nextOffset !== null && (
                        <div className="mt-4 flex justify-center">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => fetchServers(nextOffset, false)}
                            disabled={loading}
                          >
                            {loading ? "Loading…" : "Load more"}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Detail panel */}
                {detailId && (
                  <div className="w-1/2 overflow-auto">
                    <PluginDetailPanel
                      catalogId={detailId}
                      orgSlug={orgSlug}
                      pluginType={value as PluginTypeValue}
                      isDenied={servers.find((s) => s.id === detailId) ? deniedNames.includes(servers.find((s) => s.id === detailId)!.name) : false}
                      installAction={installAction}
                      onInstalled={() => onOpenChange(false)}
                      onClose={() => setDetailId(null)}
                    />
                  </div>
                )}
              </div>
            </TabsPanel>
          ))}
        </Tabs>

        {/* Footer — bulk install */}
        <DialogFooter className="flex-shrink-0 border-t border-border/40 px-6 py-4">
          <p className="mr-auto text-sm text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected` : "Select plugins to bulk-install"}
          </p>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={bulkPending}
          >
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || bulkPending}
            onClick={handleBulkInstall}
          >
            {bulkPending ? "Installing…" : `Install selected (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
```

**Note on CSP:** Plugin icons are hotlinked from their registry URLs. The existing CSP in `apps/app/next.config.ts` (or equivalent) must include `img-src` for the registry domain. Add `registry.modelcontextprotocol.io` to the CSP `img-src` directive if not already present.

**VERIFY:** Check `apps/app/next.config.ts` or `apps/app/src/app/api/` for the CSP header location before adding the domain.

- [ ] **C2** — Create `PluginDetailPanel` component

**Files:** `apps/app/src/components/plugins/plugin-detail-panel.tsx` (new)

Fetches the full catalog detail via `GET /api/v1/plugin/catalog/get?catalogId={id}` and renders: hero logo, title, author/website link, transport + auth badges, rendered README HTML via `dangerouslySetInnerHTML` (safe — `readmeHtml` is sanitized by rehype-sanitize on the server in Plan 2), tools list if available, and an Install button.

```tsx
"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, X, Plug } from "lucide-react";

interface CatalogDetail {
  id: string;
  name: string;
  title: string | null;
  description: string;
  version: string;
  websiteUrl: string | null;
  icons: Array<{ src: string }>;
  packages: unknown[];
  remotes: Array<{ transportType?: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  readmeHtml: string | null;
  status: string;
}

interface PluginDetailPanelProps {
  catalogId: string;
  orgSlug: string;
  pluginType: "mcp_server" | "integration" | "content_tool";
  isDenied: boolean;
  installAction: (input: {
    orgSlug: string;
    catalogServerId: string;
    pluginType: "mcp_server" | "integration" | "content_tool";
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  onInstalled: () => void;
  onClose: () => void;
}

export function PluginDetailPanel({
  catalogId,
  orgSlug,
  pluginType,
  isDenied,
  installAction,
  onInstalled,
  onClose,
}: PluginDetailPanelProps) {
  const [detail, setDetail] = React.useState<CatalogDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [installing, setInstalling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setError(null);
    fetch(`/api/v1/plugin/catalog/get?catalogId=${encodeURIComponent(catalogId)}`)
      .then((r) => r.json() as Promise<CatalogDetail>)
      .then((d) => { if (!cancelled) { setDetail(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : "Failed"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [catalogId]);

  const handleInstall = async () => {
    if (!detail) return;
    setInstalling(true);
    setError(null);
    try {
      const result = await installAction({ orgSlug, catalogServerId: detail.id, pluginType });
      if (!result.ok) { setError(result.error ?? "Install failed"); return; }
      onInstalled();
    } finally {
      setInstalling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <div className="h-12 w-12 rounded-xl bg-muted/40 animate-pulse" />
        <div className="h-5 w-48 rounded bg-muted/40 animate-pulse" />
        <div className="h-3 w-full rounded bg-muted/40 animate-pulse" />
        <div className="h-3 w-3/4 rounded bg-muted/40 animate-pulse" />
      </div>
    );
  }

  if (!detail) {
    return <p className="p-6 text-sm text-destructive">{error ?? "Not found"}</p>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border/40 p-6">
        {detail.icons[0] ? (
          <img src={detail.icons[0].src} alt="" className="h-12 w-12 rounded-xl object-contain flex-shrink-0" aria-hidden="true" />
        ) : (
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted flex-shrink-0">
            <Plug className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{detail.title ?? detail.name}</h3>
          <p className="text-xs text-muted-foreground">{detail.name} · v{detail.version}</p>
          {detail.websiteUrl && (
            <a
              href={detail.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {detail.websiteUrl.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Close detail"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5 border-b border-border/40 px-6 py-3">
        {detail.transportTypes.map((t) => (
          <Badge key={t} variant="outline" size="sm">{t}</Badge>
        ))}
        <Badge
          variant={detail.authKind === "oauth" ? "info" : detail.authKind === "secret" ? "warning" : "muted"}
          size="sm"
        >
          {detail.authKind === "none" ? "No auth" : detail.authKind}
        </Badge>
        {detail.categories.slice(0, 3).map((c) => (
          <Badge key={c} variant="secondary" size="sm">{c}</Badge>
        ))}
        {detail.status !== "active" && (
          <Badge variant="destructive" size="sm">{detail.status}</Badge>
        )}
      </div>

      {/* README */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <p className="mb-3 text-sm text-muted-foreground">{detail.description}</p>
        {detail.readmeHtml ? (
          // readmeHtml is sanitized by rehype-sanitize server-side in Plan 2 (catalog sync).
          // dangerouslySetInnerHTML is safe here — no user-supplied content, only registry README.
          <div
            className="prose prose-sm dark:prose-invert max-w-none text-sm"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: detail.readmeHtml }}
          />
        ) : (
          <p className="text-xs text-muted-foreground italic">No README available.</p>
        )}
      </div>

      {/* Install footer */}
      <div className="flex-shrink-0 border-t border-border/40 px-6 py-4">
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        {isDenied ? (
          <p className="text-sm text-muted-foreground italic">
            Blocked by your organization&apos;s admins — cannot install.
          </p>
        ) : (
          <Button
            className="w-full"
            onClick={handleInstall}
            disabled={installing || detail.status !== "active"}
          >
            {installing ? "Installing…" : "Install to organization"}
          </Button>
        )}
      </div>
    </div>
  );
}
```

**Commit:** `feat(app): marketplace modal — type tabs, search/filter, card grid, bulk install, detail panel`

---

## Task D — API GET routes for catalog (modal data fetching)

The `MarketplaceModal` fetches via `GET /api/v1/plugin/catalog/browse` and `GET /api/v1/plugin/catalog/get`. The existing API routes are POST-only (`plugin.catalog.browse.ts`, `plugin.catalog.get.ts`). The modal needs GET endpoints to enable browser-native navigation caching.

- [ ] **D1** — Add GET handler to `plugin.catalog.browse` API route

**Files:** `apps/app/src/app/api/v1/plugin/catalog/browse/route.ts` (new — App Router API route)

**VERIFY:** Check whether the existing catalog routes live in `apps/app/src/app/api/` (Next.js App Router) or in `apps/api/src/routes/` (Hono). The Hono routes are served by the separate `apps/api` service; the Next.js App Router in `apps/app` handles `/api/v1/` only for routes defined under `apps/app/src/app/api/`. The MarketplaceModal is part of `apps/app`, so create an `apps/app` API route.

```ts
import { type NextRequest, NextResponse } from "next/server";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSession } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") ?? undefined;
  const authKind = searchParams.get("authKind") as "oauth" | "secret" | "none" | null ?? undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "30", 10), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);

  const ctx = {
    orgId: "",  // catalog.browse is scoped=false — org context not required
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke(
      "plugin.catalog.browse",
      { search, authKind, limit, offset },
      ctx,
      { surface: "agent" },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Browse failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **D2** — Add GET handler for catalog detail

**Files:** `apps/app/src/app/api/v1/plugin/catalog/get/route.ts` (new)

```ts
import { type NextRequest, NextResponse } from "next/server";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const catalogId = request.nextUrl.searchParams.get("catalogId");
  if (!catalogId) {
    return NextResponse.json({ error: "catalogId is required" }, { status: 400 });
  }

  const ctx = {
    orgId: "",
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke("plugin.catalog.get", { catalogId }, ctx, { surface: "agent" });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Get failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Commit:** `feat(app): Add GET API routes for plugin catalog browse + detail`

---

## Task E — Workspace install surface (replace integrations stub)

Replace `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` (currently a static stub) with a real server component that lists the org allow-list and lets workspace members enable/disable per plugin.

- [ ] **E1** — Create workspace plugin server actions

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/integration-actions.ts` (new)

Pattern: mirror `models-action.ts` exactly (resolve org + workspace, assert org member, gate on workspace-level owner/admin role, invoke).

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

function buildCtx(opts: { orgId: string; workspaceId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

const NOT_AUTHORIZED = "Only workspace owners and admins can manage integrations.";

// ── setWorkspacePluginEnabledAction ───────────────────────────────────────────
const SetWsEnabledSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  enabled: z.boolean(),
});

export async function setWorkspacePluginEnabledAction(
  input: z.infer<typeof SetWsEnabledSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SetWsEnabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, enabled } = parsed.data;
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const wsRoleRows = await withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, ws.id),
            eq(schema.workspaceUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    );

    const wsRole = wsRoleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
      return { ok: false, error: NOT_AUTHORIZED };
    }

    const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
    try {
      await invoke("plugin.workspace.set_enabled", { orgListingId, enabled }, ctx, { surface: "agent" });
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.integrations(routeCtx));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Update failed" };
    }
  });
}

// ── setSecretAction ───────────────────────────────────────────────────────────
const SetSecretSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  secret: z.string().min(1).max(2048),
});

export async function setSecretAction(
  input: z.infer<typeof SetSecretSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SetSecretSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, secret } = parsed.data;
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const wsRoleRows = await withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, ws.id),
            eq(schema.workspaceUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    );

    const wsRole = wsRoleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
      return { ok: false, error: NOT_AUTHORIZED };
    }

    const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
    try {
      await invoke(
        "plugin.credential.set_secret",
        { orgListingId, authKind: "secret", secret },
        ctx,
        { surface: "agent" },
      );
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.integrations(routeCtx));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to save secret" };
    }
  });
}
```

- [ ] **E2** — Replace the integrations stub page

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` (replace)

```tsx
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { WorkspaceIntegrationsPanel } from "./workspace-integrations-panel";
import { setWorkspacePluginEnabledAction, setSecretAction } from "./integration-actions";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export const dynamic = "force-dynamic";

export default async function SettingsIntegrationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Read viewer workspace role
  const [wsRoleRow] = await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
    withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, ws.id),
            eq(schema.workspaceUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    ),
  );

  const wsRole = wsRoleRow?.role ?? "viewer";
  const canManage = ["owner", "admin"].includes(wsRole.toLowerCase());

  // Fetch the org allow-list (enabled org listings available to this workspace)
  // VERIFY: schema.pluginOrgListings — check packages/database/src/schema/ for exact table/column names.
  const orgListings = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgListings)
        .where(eq(schema.pluginOrgListings.orgId, org.id))
        .orderBy(schema.pluginOrgListings.name),
    ),
  ).catch(() => []);

  // Fetch workspace-level install rows to get per-listing enabled state + health
  // VERIFY: schema.mcpServers (agent.mcp_servers) — check that the table has org_listing_id column (added in Plan 1 migration).
  const wsInstalls = await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.mcpServers)
        .where(eq(schema.mcpServers.workspaceId, ws.id)),
    ),
  ).catch(() => []);

  // Build a map: orgListingId → workspace install row
  type WsInstall = (typeof wsInstalls)[number];
  const wsInstallMap = new Map<string, WsInstall>();
  for (const row of wsInstalls) {
    // VERIFY: row.orgListingId — the column name on the workspace install row.
    if (row.orgListingId) wsInstallMap.set(row.orgListingId, row);
  }

  return (
    <WorkspaceIntegrationsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      orgListings={orgListings}
      wsInstallMap={Object.fromEntries(wsInstallMap)}
      setEnabledAction={setWorkspacePluginEnabledAction}
      setSecretAction={setSecretAction}
    />
  );
}
```

- [ ] **E3** — Create `WorkspaceIntegrationsPanel` client component

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/workspace-integrations-panel.tsx` (new)

This client component renders the workspace-level plugin list. Each row shows:
- Plugin icon + name + type badge + auth kind badge
- Health status indicator (green dot = healthy, red = error, grey = unknown/unconfigured)
- Enabled `Switch` (calls `setEnabledAction` on change)
- **For `authKind === "secret"`:** a collapsed "Set API key" form that expands on button click; shows `<input type="password">` + Save. Uses `setSecretAction`.
- **For `authKind === "oauth"`:** a "Connect" / "Reconnect" `<a>` that links to the authorize route at `/api/v1/plugins/oauth/start?orgListingId={id}` (Plan 4 shipped this route). VERIFY the exact OAuth start route path from Plan 4.
- If `orgListings` is empty: empty state matching the current stub's visual treatment (centered icon + copy), but with a link to `org.settings.plugins(ctx)` + "Ask your org admin to install some plugins from the marketplace."

Row disabled state: if the org listing's `enabled = false`, the workspace toggle is grayed out with tooltip "Enable this plugin at the org level first."

```tsx
"use client";
import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plug, CheckCircle2, AlertCircle, Circle, ExternalLink } from "lucide-react";
import { org } from "@/lib/routes";
// ... full component implementation with the behaviors above
```

The health status column reads from `wsInstallMap[listing.id]?.healthStatus`:
- `"healthy"` → `<CheckCircle2 className="h-3.5 w-3.5 text-success" />`
- `"error"` or `"degraded"` → `<AlertCircle className="h-3.5 w-3.5 text-destructive" />`
- `null` / `undefined` / not yet installed → `<Circle className="h-3.5 w-3.5 text-muted-foreground/40" />` (not yet enabled)

**Commit:** `feat(app): workspace integrations page — org allow-list, enable/disable, secret entry, OAuth connect link`

---

## Task F — Re-auth deep-link page

- [ ] **F1** — Create re-auth route

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/reauth/[listingId]/page.tsx` (new)

This is the deep-link target page from in-app notifications (Plan 5) and emails. It shows the plugin details and a "Reconnect" button that links to the OAuth start route.

```tsx
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { Plug, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export default async function ReauthPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; listingId: string }>;
}) {
  const { orgSlug, workspaceSlug, listingId } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Resolve the listing by public_id (listingId from the URL is the public_id).
  // VERIFY: schema.pluginOrgListings — check column name for public_id (idMixin: `public_id`).
  const [listing] = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgListings)
        .where(
          and(
            eq(schema.pluginOrgListings.publicId, listingId),
            eq(schema.pluginOrgListings.orgId, org.id),
          ),
        )
        .limit(1),
    ),
  ).catch(() => []);

  if (!listing) notFound();

  const oauthStartUrl = `/api/v1/plugins/oauth/start?orgListingId=${listing.id}&workspaceId=${ws.id}`;
  // VERIFY: the OAuth start route path — Plan 4 ships it. Adjust if the path differs.

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        {/* Icon: use listing.iconUrl if present, else generic */}
        {listing.iconUrl ? (
          <img src={listing.iconUrl} alt="" className="h-8 w-8 rounded object-contain" aria-hidden="true" />
        ) : (
          <Plug className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        )}
      </div>

      <div className="flex flex-col gap-2 max-w-sm">
        <h1 className="text-lg font-semibold">{listing.title ?? listing.name}</h1>
        <p className="text-sm text-muted-foreground">
          Your connection to <strong>{listing.title ?? listing.name}</strong> has expired or been revoked.
          Reconnect to restore access.
        </p>
      </div>

      {listing.authKind === "oauth" ? (
        <Button render={<Link href={oauthStartUrl} />}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Reconnect {listing.title ?? listing.name}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Contact your org admin to update the API key for this plugin in{" "}
          <Link href={`/${orgSlug}/settings/plugins`} className="text-primary underline">
            Org Settings → Plugins
          </Link>
          .
        </p>
      )}
    </div>
  );
}
```

**Note on `render` prop:** `Button` is a coss component wrapping `useRender`. For a `Link` render, use `render={<Link href={...} />}` (the `render` prop pattern from Base UI — confirmed in `badge.tsx`). If `Button` does not expose a `render` prop, use `asChild={false}` and wrap in a plain `<a>` or style the Link directly.

**VERIFY:** Check `apps/app/src/components/ui/button.tsx` for whether it exposes a `render` prop.

**Commit:** `feat(app): re-auth deep-link page for plugin OAuth reconnect`

---

## Task G — Org alert settings toggle (mcp_auth_alerts)

- [ ] **G1** — Add auth-alert settings UI to the org Plugins page

Per the spec (§7), orgs have a `settings.mcp_auth_alerts = { send_email: bool, roles: string[] }` JSONB field on `org.organizations.settings`. This task adds the UI toggle + role multiselect at the bottom of `OrgPluginsPanel`.

The `plugin.settings.set_auth_alerts` contract does NOT exist yet (not in `packages/oxagen/src/contracts/`). Implement the UI shell and use a direct DB update server action as a stop-gap until the capability is shipped.

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/plugin-actions.ts` (append to existing)

```ts
// ── setAuthAlertsAction ───────────────────────────────────────────────────────
// Stop-gap direct DB update. Replace with invoke("plugin.settings.set_auth_alerts", ...)
// once that capability is shipped (tracked in Linear).
const AuthAlertsSchema = z.object({
  orgSlug: z.string().min(1),
  sendEmail: z.boolean(),
  roles: z.array(z.string()).min(1),
});

export async function setAuthAlertsAction(
  input: z.infer<typeof AuthAlertsSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = AuthAlertsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };

  const { withTenantDb, schema } = await import("@oxagen/database");
  const { eq } = await import("drizzle-orm");

  try {
    await runInTenantScope({ orgId: managed.orgId, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb((tx) =>
        tx
          .update(schema.organizations)
          .set({
            settings: tx.sql`
              COALESCE(settings, '{}'::jsonb) ||
              jsonb_build_object('mcp_auth_alerts', jsonb_build_object(
                'send_email', ${parsed.data.sendEmail}::boolean,
                'roles', ${JSON.stringify(parsed.data.roles)}::jsonb
              ))
            `,
          })
          .where(eq(schema.organizations.id, managed.orgId)),
      ),
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to update alert settings" };
  }
}
```

**VERIFY:** Check `schema.organizations.settings` — if the column is `jsonb`, the `||` merge operator works. If it's `text` or absent, adjust accordingly.

- [ ] **G2** — Add `OrgAuthAlertsSection` to `OrgPluginsPanel`

Add a new section at the bottom of `org-plugins-panel.tsx`:

```tsx
// OrgAuthAlertsSection — inside OrgPluginsPanel, after the Denylist section
// Shows only when canManage = true

function OrgAuthAlertsSection({
  orgSlug,
  initialSendEmail,
  initialRoles,
  setAuthAlertsAction,
}: {
  orgSlug: string;
  initialSendEmail: boolean;
  initialRoles: string[];
  setAuthAlertsAction: (input: { orgSlug: string; sendEmail: boolean; roles: string[] }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const AVAILABLE_ROLES = ["Owner", "Admin"] as const;
  const [sendEmail, setSendEmail] = React.useState(initialSendEmail);
  const [roles, setRoles] = React.useState<string[]>(initialRoles);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggleRole = (role: string) =>
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );

  const handleSave = async () => {
    if (roles.length === 0) { setError("At least one role must be selected."); return; }
    setSaving(true);
    setError(null);
    const result = await setAuthAlertsAction({ orgSlug, sendEmail, roles });
    setSaving(false);
    if (!result.ok) setError(result.error ?? "Save failed");
  };

  return (
    <div className="rounded-xl border border-border/60 p-6">
      <h3 className="mb-1 text-sm font-medium">Re-authentication alerts</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        Notify selected org roles when a plugin&apos;s OAuth token expires and requires re-authentication.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <Switch
          checked={sendEmail}
          onCheckedChange={setSendEmail}
          id="send-email-toggle"
        />
        <label htmlFor="send-email-toggle" className="text-sm">Send email notifications</label>
      </div>

      <div className="flex flex-col gap-2 mb-4">
        <p className="text-xs font-medium text-muted-foreground">Notify roles</p>
        <div className="flex gap-3">
          {AVAILABLE_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              {role}
            </label>
          ))}
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <Button size="sm" onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save alert settings"}
      </Button>
    </div>
  );
}
```

**Commit:** `feat(app): org auth-alert settings — send_email toggle + role multiselect`

---

## Task H — Typecheck, lint, and manual verification checklist

- [ ] **H1** — Run typecheck + lint

```bash
cd /Users/macanderson/oxagen-monorepo
pnpm --filter @oxagen/app tsc --noEmit
pnpm --filter @oxagen/app lint
```

Fix every error before declaring done. Common gotchas:
- Missing `"use client"` on components that use `React.useState` or event handlers.
- Missing `"use server"` on actions files.
- Missing `import "@oxagen/handlers/register"` in any `invoke()` caller (server-only side effect — TypeScript does not catch this).
- `any` usage — use precise types or `unknown`. The `withTenantDb` query results are typed by Drizzle; use them.
- Drizzle schema column names — verify `schema.pluginOrgListings`, `schema.pluginOrgDenylist`, `schema.mcpServers` against `packages/database/src/schema/` before committing.

- [ ] **H2** — Manual browser verification checklist

Using the chrome-devtools MCP (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`), verify the following in order (log in via `creds.json` first):

1. **Org Plugins settings page loads:**
   - Navigate to `http://localhost:3000/{orgSlug}/settings/plugins`.
   - Assert: "Plugins" tab is visible in the settings nav alongside "General".
   - Assert: Registries section shows the default MCP seed registry with a "Default" badge and no Remove button.
   - Assert: If no plugins installed, the allow-list shows an empty state or an empty table.
   - Assert: Denylist section renders.

2. **Marketplace modal opens:**
   - Click "Browse marketplace" button.
   - Assert: `<dialog>` element is open and `max-w-5xl` class is applied.
   - Assert: Three type tabs render (MCP Servers / Integrations / Content Tools).
   - Assert: Server cards load (spinner, then grid).
   - Assert: Auth filter chips render and clicking "oauth" re-fetches.
   - Assert: Clicking a card opens the detail panel on the right.
   - Assert: Detail panel shows logo, title, transport/auth badges, and README (or "No README" fallback).

3. **Multi-select bulk install:**
   - Select 2 servers via their checkboxes.
   - Assert: "Install selected (2)" button in footer is enabled.
   - Click it; assert: the modal closes (or shows success).
   - Assert: installed servers appear in the org allow-list on the Plugins page.

4. **Single install from detail panel:**
   - Open a server detail, click "Install to organization".
   - Assert: the modal closes and the allow-list updates.

5. **Org enable/disable toggle:**
   - On the Plugins page allow-list, toggle a plugin's Switch.
   - Assert: Switch reflects the new state without page reload.

6. **Denylist a server:**
   - Enter a server name in the Denylist form, click "Deny".
   - Assert: the server appears in the denylist table.
   - Re-open the marketplace — assert the denied server's card is greyed out with "Blocked by your organization's admins".

7. **Workspace integrations page:**
   - Navigate to `/{orgSlug}/{workspaceSlug}/settings/integrations`.
   - Assert: the stub is replaced with the real panel.
   - Assert: installed org plugins are listed.
   - Assert: the workspace enable/disable Switch works.

8. **Re-auth page:**
   - Navigate to `/{orgSlug}/{workspaceSlug}/settings/integrations/reauth/{any-listing-public-id}`.
   - Assert: page renders with plugin name + "Reconnect" button (OAuth listing) or the API key fallback copy.

9. **Non-admin role gate:**
   - Log in as a workspace member (non-owner/non-admin).
   - Assert: accessing `/{orgSlug}/settings/plugins` as a non-manager returns 404 (Next.js `notFound()` behavior).

> Full E2E Playwright suite (mock OAuth server, agent integration, RBAC negative tests) is Plan 7.

**Commit:** `chore(app): typecheck + manual verify — Plan 6 UI complete`

---

## Done criteria

- [ ] `assertMcpManager` lives in `apps/app/src/lib/resolve-org.ts` alongside `assertBillingManager`.
- [ ] `resolveManagedOrgForPlugins` is the sole authorization gate for all org plugin server actions.
- [ ] Org Plugins settings page (`/{orgSlug}/settings/plugins`) renders with registries, allow-list, custom-server form, denylist, and auth-alert toggle.
- [ ] Settings nav at `/{orgSlug}/settings/` shows "General" and "Plugins" tabs (layout.tsx added).
- [ ] `routes.ts` has `org.settings.plugins`.
- [ ] Marketplace modal opens from Plugins page, shows three type tabs, filters, card grid with multi-select, detail panel with README HTML, bulk install, and denied-server treatment.
- [ ] `GET /api/v1/plugin/catalog/browse` and `GET /api/v1/plugin/catalog/get` Next.js API routes are wired and authenticated.
- [ ] Workspace integrations page (`/{orgSlug}/{workspaceSlug}/settings/integrations`) replaces the stub with a real panel (allow-list, enable toggle, secret form, OAuth link, health status).
- [ ] Re-auth deep-link page (`/…/integrations/reauth/[listingId]`) renders and links to the OAuth start route.
- [ ] `setAuthAlertsAction` updates `org.organizations.settings.mcp_auth_alerts`.
- [ ] `pnpm tsc --noEmit` passes for `apps/app`.
- [ ] Manual browser checklist (Task H) fully checked off.
- [ ] No `any` types. No dead code. No glass/translucency in any component. No `asChild` — use `render` prop.
- [ ] All VERIFY pointers resolved (schema names confirmed, button render-prop confirmed, OAuth start path confirmed).

**Next plan:** `docs/superpowers/plans/2026-06-06-installable-plugins-07-e2e-docs.md`
