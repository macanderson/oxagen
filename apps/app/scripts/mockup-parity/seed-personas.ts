// The persona seed of the mockup parity audit (#4818). CI-only audit tooling:
// `.github/workflows/mockup-parity-capture.yml` runs it as
// `pnpm --filter @oxagen/app seed:audit`, after `seed:e2e`, and nothing else
// does. The three e2e specs never read what it writes (ARCHITECTURE.md §5,
// §6.3), and nothing under `src/` imports it (INV-07, INV-22).
//
// On top of the e2e seed (one owner, e2e-org, workspace core, one run) it adds,
// idempotently:
//
//   1. one account per persona in personas.ts, through Better Auth's sign-up
//      API, followed by the credential sign-in self-check seed:e2e runs for
//      the owner;
//   2. each persona's membership of e2e-org, the way a person joins in the
//      product: the owner invites through send_workspace_invite, the persona
//      accepts through accept_member_invite, and the owner sets a Billing or
//      Compliance role through change_member_role;
//   3. each persona's role in workspace core;
//   4. a second workspace, `empty`, through create_workspace, where each
//      persona holds the role it holds in core (marcus owns it) and nothing
//      else is added;
//   5. the outsider's own organization, e2e-outside, through create_org;
//   6. the ids a capture path names beyond the run: the agent and runtime
//      seed:e2e registered, one stdio MCP server through register_mcp_server,
//      the owner's principal as the operator, one steering proposal through
//      append_record, and three invitations for the `invite` page (open,
//      expired, and declined) through send_workspace_invite and
//      decline_member_invite.
//
// It writes e2e/.auth/personas.json (PERSONAS_RECORD): every slug and id a
// capture path needs, and the reason for each one it could not seed.
//
// Two writes have no package API, and go through @oxagen/database's typed
// schema inside the right tenant transaction, the way seed:e2e writes its
// retention policy: a workspace membership (create_workspace writes its
// creator's row, and nothing adds a member to a workspace that exists), and
// the expired invitation's expiry (no capability moves one into the past).
//
// Runs under E2E_TEST=true (the package.json script sets it), for the reason
// seed:e2e does: sign-up leaves emailVerified false, and the sign-in
// self-check must see the relaxation the server runs with.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { auth } from "@oxagen/auth/server";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { type CapabilityContext, ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import { agentMcpRegister } from "@oxagen/oxagen/contracts/agent.mcp.register";
import { contextRecordsAppend } from "@oxagen/oxagen/contracts/context.records.append";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { orgMemberRoleChange } from "@oxagen/oxagen/contracts/org.member_role.change";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";
import { invoke } from "@oxagen/oxagen/kernel";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { AUTH_DIR, SEED } from "../../e2e/support";
import {
  EMPTY_WORKSPACE,
  INVITATIONS,
  type OrgRole,
  OUTSIDE_ORG,
  PERSONA_PASSWORD,
  PERSONAS,
  PERSONAS_RECORD,
  type PersonaKey,
  type PersonasRecord,
  personasRecordSchema,
  type WorkspaceRole,
} from "./personas";

/** The agent seed:e2e registers in core (e2e/support/seed/index.ts, AGENT). */
const SEEDED_AGENT_SLUG = "e2e-agent";

/** The runtime seed:e2e registers that agent on (RUNTIME there). */
const SEEDED_RUNTIME_SLUG = "e2e-runtime";

/**
 * The MCP server this seed registers in core. A stdio server is stored as
 * given and probed by nobody, so registering it reaches no network.
 */
const TOOL_SERVER = {
  name: "E2E tools",
  endpointUrl: "stdio://e2e-tools",
} as const;

/** The first step of the register flow, `/{org}/{ws}/register/<step>`. */
const FIRST_REGISTER_STEP = "name";

/** Why no mandate is seeded. The capture cites it for a path with `{mandate}`. */
const MANDATE_MISSING =
  "No mandate is seeded. grant_mandate refuses a tool pattern that matches no declared tool with a measure, and declaring one takes import_tools from a live tool server, which this CI job does not run.";

/** Why no steering record is seeded. The capture cites it for `{record}`. */
const RECORD_MISSING =
  "No published steering record is seeded. A record is published through a Context PR on the workspace's steering repository, which CI cannot reach.";

/** Why no tool key is seeded. The capture cites it for `{tool}`. */
const TOOL_MISSING =
  "No tool call is seeded. A tool's key comes from a call a run recorded, and the run seed:e2e seals records none.";

/** The steering proposal the steering-pr page opens, appended by the owner. */
const PROPOSAL = {
  lineageId: "e2e-audit-proposal",
  statement: "Run the package's unit tests before opening a pull request.",
  rationale:
    "Seeded for the mockup parity capture, so the proposals page has one to open.",
} as const;

/** How far past its expiry the expired invitation is set: one day. */
const EXPIRED_BY_MS = 24 * 60 * 60 * 1000;

class SeedError extends Error {}

function log(step: string, detail: Record<string, unknown> = {}): void {
  console.log(`[seed:audit] ${step}`, JSON.stringify(detail));
}

type Scope = { orgId: string; workspaceId: string };
type Account = { email: string; userId: string };

/** A kernel context for `userId`, as the app's kernel seam builds one. */
function ctxFor(
  userId: string,
  orgId: string,
  workspaceId: string,
): CapabilityContext {
  return {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: randomUUID(),
    surface: "app",
    messageId: null,
  };
}

// ── 1. Accounts ───────────────────────────────────────────────────────────

function isAlreadyRegistered(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { body?: { code?: string }; message?: string };
  return /USER_ALREADY_EXISTS/i.test(
    e.body?.code ?? (e.message ?? "").replace(/[\s.-]+/g, "_"),
  );
}

/** The `cookie` request header that presents every cookie a response set. */
function cookieFromSetCookie(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0] ?? "")
    .filter((pair) => pair.length > 0)
    .join("; ");
}

/**
 * Sign the persona up, then sign in with the same password. The capture signs
 * in through the login form, so an account that cannot sign in here would
 * fail every one of its states later with a less direct error.
 */
async function seedAccount(email: string, name: string): Promise<string> {
  try {
    await auth.api.signUpEmail({
      body: { email, password: PERSONA_PASSWORD, name },
    });
    log("account signed up", { email });
  } catch (error) {
    if (!isAlreadyRegistered(error)) throw error;
    log("account already registered", { email });
  }
  const { headers, response: signedIn } = await auth.api.signInEmail({
    body: { email, password: PERSONA_PASSWORD },
    returnHeaders: true,
  });
  if (signedIn.token.length === 0) {
    throw new SeedError(
      `credential sign-in for ${email} returned no session token`,
    );
  }
  await auth.api.signOut({
    headers: new Headers({ cookie: cookieFromSetCookie(headers) }),
  });
  log("account sign-in verified", { email, userId: signedIn.user.id });
  return signedIn.user.id;
}

// ── Lookups ───────────────────────────────────────────────────────────────

async function ownerUserId(): Promise<string> {
  // tenancy: seed bootstrap read of the e2e owner's user id, filtered by the seeded email; auth.users is global and carries no org_id.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, SEED.email))
      .limit(1),
  );
  const row = rows[0];
  if (!row) {
    throw new SeedError(`${SEED.email} has no account; run seed:e2e first`);
  }
  return row.id;
}

async function findOrgId(slug: string): Promise<string | null> {
  // tenancy: seed bootstrap lookup of an organization, filtered by its slug before any tenant scope for it exists.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1),
  );
  return rows[0]?.id ?? null;
}

async function findWorkspaceId(
  orgId: string,
  slug: string,
): Promise<string | null> {
  // tenancy: seed bootstrap lookup of one workspace, filtered by its orgId and slug before any tenant scope for it exists.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, orgId),
          eq(schema.workspaces.slug, slug),
        ),
      )
      .limit(1),
  );
  return rows[0]?.id ?? null;
}

/** e2e-org and core, which seed:e2e made. */
async function coreScope(): Promise<Scope> {
  const orgId = await findOrgId(SEED.orgSlug);
  const workspaceId =
    orgId === null ? null : await findWorkspaceId(orgId, SEED.workspaceSlug);
  if (orgId === null || workspaceId === null) {
    throw new SeedError(
      `${SEED.orgSlug}/${SEED.workspaceSlug} does not exist; run seed:e2e first`,
    );
  }
  return { orgId, workspaceId };
}

/** The persona's organization role, lowercased; null for a non-member. */
async function orgRoleOf(
  orgId: string,
  userId: string,
): Promise<string | null> {
  // tenancy: seed bootstrap read of one membership row, filtered by the orgId and the persona's userId it is about to write.
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
  // org_users.role is written in both casings: 'Member' by the accept path,
  // 'Billing' by change_member_role (tenancy-lookups.ts reads it the same way).
  return rows[0]?.role.toLowerCase() ?? null;
}

// ── 2. Organization membership ────────────────────────────────────────────

/** send_workspace_invite offers member, admin, and owner. Billing and
 * Compliance are set afterwards through change_member_role. */
function inviteRole(role: OrgRole): "member" | "admin" | "owner" {
  return role === "owner" || role === "admin" ? role : "member";
}

/** The org-scoped IAM role names change_member_role takes (ORG_ROLES in
 * packages/handlers/src/iam-provision.ts). */
const ROLE_NAMES = { billing: "Billing", compliance: "Compliance" } as const;

async function seedOrgMembership(
  core: Scope,
  ownerId: string,
  key: PersonaKey,
  account: Account,
  role: OrgRole,
): Promise<void> {
  let current = await orgRoleOf(core.orgId, account.userId);
  if (current === null) {
    // The owner invites from the organization, and the invitee accepts as the
    // app's invite page does: signed in as themselves, with the invitation's
    // organization and no workspace (InviteeCtx in src/server/kernel.ts).
    const sent = workspaceInviteSend.output.parse(
      await invoke(
        workspaceInviteSend.name,
        { email: account.email, role: inviteRole(role) },
        ctxFor(ownerId, core.orgId, core.workspaceId),
      ),
    );
    await invoke(
      orgMemberInviteAccept.name,
      { invitationPublicId: sent.id },
      ctxFor(account.userId, core.orgId, ORG_ONLY_WORKSPACE_ID),
    );
    log("persona joined the organization", {
      persona: key,
      invitation: sent.id,
    });
    current = await orgRoleOf(core.orgId, account.userId);
  }
  if (current === role) return;
  if (role === "billing" || role === "compliance") {
    // An organization-level write: the app invokes it with the org-only
    // workspace sentinel, and the handler reads organisation-wide.
    await invoke(
      orgMemberRoleChange.name,
      { targetUserId: account.userId, newRole: ROLE_NAMES[role] },
      ctxFor(ownerId, core.orgId, ORG_ONLY_WORKSPACE_ID),
    );
    log("persona organization role set", { persona: key, role });
    return;
  }
  throw new SeedError(
    `${key} holds ${current ?? "no role"} in ${SEED.orgSlug}, not ${role}; seed a fresh database`,
  );
}

// ── 3. Workspace membership ───────────────────────────────────────────────

async function seedWorkspaceRole(
  scope: Scope,
  actorId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  // No package API adds a member to a workspace that exists: create_workspace
  // writes its creator's row, and nothing else writes workspace_users. So the
  // row goes through the typed schema, in this workspace's tenant scope,
  // because workspace_users is workspace_only under RLS. The role is stored
  // lowercased, as the create path stores it.
  await runInTenantScope({ ...scope, userId: actorId }, () =>
    withTenantDb((tx) =>
      tx
        .insert(schema.workspaceUsers)
        .values({
          workspaceId: scope.workspaceId,
          userId,
          role,
          joinedAt: new Date(),
          createdById: actorId,
          updatedById: actorId,
        })
        .onConflictDoUpdate({
          target: [
            schema.workspaceUsers.workspaceId,
            schema.workspaceUsers.userId,
          ],
          set: { role, updatedAt: new Date(), updatedById: actorId },
        }),
    ),
  );
}

// ── 4. The empty workspace ────────────────────────────────────────────────

/**
 * create_workspace refuses an organization Member, so the owner creates it.
 * Each persona then gets the role it holds in core, so marcus owns it and any
 * persona's page can be captured empty. It holds what a new workspace holds
 * and nothing more.
 */
async function seedEmptyWorkspace(
  core: Scope,
  ownerId: string,
  accounts: ReadonlyMap<PersonaKey, Account>,
): Promise<void> {
  let workspaceId = await findWorkspaceId(core.orgId, EMPTY_WORKSPACE.slug);
  if (workspaceId === null) {
    await invoke(
      workspaceCreate.name,
      { name: EMPTY_WORKSPACE.name, slug: EMPTY_WORKSPACE.slug },
      ctxFor(ownerId, core.orgId, core.workspaceId),
    );
    log("empty workspace created", { slug: EMPTY_WORKSPACE.slug });
    workspaceId = await findWorkspaceId(core.orgId, EMPTY_WORKSPACE.slug);
    if (workspaceId === null) {
      throw new SeedError(
        `create_workspace returned but ${EMPTY_WORKSPACE.slug} is not readable`,
      );
    }
  } else {
    log("empty workspace already exists", { slug: EMPTY_WORKSPACE.slug });
  }
  for (const persona of PERSONAS) {
    const account = accounts.get(persona.key);
    if (!account || persona.workspaceRole === null) continue;
    await seedWorkspaceRole(
      { orgId: core.orgId, workspaceId },
      ownerId,
      account.userId,
      persona.workspaceRole,
    );
  }
}

// ── 5. The outsider's organization ────────────────────────────────────────

async function seedOutsideOrg(outsiderId: string): Promise<void> {
  if ((await findOrgId(OUTSIDE_ORG.slug)) !== null) {
    log("outside organization already exists", { slug: OUTSIDE_ORG.slug });
    return;
  }
  // create_org is scoped: false, so the outsider calls it before any tenant
  // exists, the way seed:e2e creates e2e-org for its owner.
  await invoke(
    organizationCreate.name,
    {
      name: OUTSIDE_ORG.name,
      slug: OUTSIDE_ORG.slug,
      workspace: {
        name: OUTSIDE_ORG.workspaceName,
        slug: OUTSIDE_ORG.workspaceSlug,
      },
    },
    ctxFor(outsiderId, "", ""),
  );
  if ((await findOrgId(OUTSIDE_ORG.slug)) === null) {
    throw new SeedError(
      `create_org returned but ${OUTSIDE_ORG.slug} is not readable`,
    );
  }
  log("outside organization created", { slug: OUTSIDE_ORG.slug });
}

// ── 6. The ids a capture path names ───────────────────────────────────────

type CaptureIds = Pick<PersonasRecord, "values" | "missing">;

/** The stdio MCP server's public id, registered on the first run. */
async function seedToolServer(core: Scope, ownerId: string): Promise<string> {
  const [existing] = await withTenantDb((tx) =>
    tx
      .select({ publicId: schema.mcpServers.publicId })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.workspaceId, core.workspaceId),
          eq(schema.mcpServers.name, TOOL_SERVER.name),
          isNull(schema.mcpServers.deletedAt),
        ),
      )
      .limit(1),
  );
  if (existing) return existing.publicId;
  const registered = agentMcpRegister.output.parse(
    await invoke(
      agentMcpRegister.name,
      {
        name: TOOL_SERVER.name,
        transportType: "stdio",
        endpointUrl: TOOL_SERVER.endpointUrl,
        authStrategy: "none",
      },
      ctxFor(ownerId, core.orgId, core.workspaceId),
    ),
  );
  log("tool server registered", { server: registered.mcpServerId });
  return registered.mcpServerId;
}

/** Agent, runtime, MCP server, and operator, in core's tenant scope. */
async function seedCaptureIds(
  core: Scope,
  ownerId: string,
): Promise<CaptureIds> {
  return runInTenantScope({ ...core, userId: ownerId }, async () => {
    const values: CaptureIds["values"] = {};
    const missing: CaptureIds["missing"] = {};

    const [agent] = await withTenantDb((tx) =>
      tx
        .select({ slug: schema.agents.slug })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, core.workspaceId),
            eq(schema.agents.slug, SEEDED_AGENT_SLUG),
          ),
        )
        .limit(1),
    );
    if (agent) {
      values.agent = agent.slug;
    } else {
      missing.agent = `seed:e2e registered no agent ${SEEDED_AGENT_SLUG} in ${SEED.workspaceSlug}`;
    }

    const [runtime] = await withTenantDb((tx) =>
      tx
        .select({ publicId: schema.runtimes.publicId })
        .from(schema.runtimes)
        .where(
          and(
            eq(schema.runtimes.workspaceId, core.workspaceId),
            eq(schema.runtimes.slug, SEEDED_RUNTIME_SLUG),
          ),
        )
        .limit(1),
    );
    if (runtime) {
      values.runtime = runtime.publicId;
    } else {
      missing.runtime = `seed:e2e registered no runtime ${SEEDED_RUNTIME_SLUG} in ${SEED.workspaceSlug}`;
    }

    // The operator is a human principal: the owner's, because the seeded run
    // is theirs, so theirs is the one operator with recorded activity.
    const [operator] = await withTenantDb((tx) =>
      tx
        .select({ publicId: schema.principals.publicId })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, core.orgId),
            eq(schema.principals.parentUserId, ownerId),
            eq(schema.principals.kind, "human"),
            isNull(schema.principals.workspaceId),
          ),
        )
        .limit(1),
    );
    if (operator) {
      values.operator = operator.publicId;
    } else {
      missing.operator =
        "the owner has no human principal in the organization";
    }

    values.server = await seedToolServer(core, ownerId);

    const proposal = await seedProposal(core, ownerId);
    if (proposal !== null) {
      values.proposal = proposal;
    } else {
      missing.proposal = "append_record opened no steering proposal";
    }
    return { values, missing };
  });
}

/**
 * One steering proposal, the way an agent proposes a record: append_record
 * with kind record_proposal. The append is content-addressed, so a second run
 * returns the same proposal.
 */
async function seedProposal(
  core: Scope,
  ownerId: string,
): Promise<string | null> {
  const appended = contextRecordsAppend.output.parse(
    await invoke(
      contextRecordsAppend.name,
      {
        kind: "record_proposal",
        lineageId: PROPOSAL.lineageId,
        statement: PROPOSAL.statement,
        proposal: {
          kind: "rule",
          force: "should",
          rationale: PROPOSAL.rationale,
        },
      },
      ctxFor(ownerId, core.orgId, core.workspaceId),
    ),
  );
  log("steering proposal seeded", { proposal: appended.proposalId });
  return appended.proposalId;
}

/**
 * The owner's invitation for `email`, as a Member. send_workspace_invite
 * returns the pending invitation that already exists for an email, so a
 * second run reuses it.
 */
async function sendInvitation(
  core: Scope,
  ownerId: string,
  email: string,
): Promise<string> {
  const sent = workspaceInviteSend.output.parse(
    await invoke(
      workspaceInviteSend.name,
      { email, role: "member" },
      ctxFor(ownerId, core.orgId, core.workspaceId),
    ),
  );
  return sent.id;
}

/** A declined invitation for `email` already in the organization, if any. */
async function declinedInvitation(
  core: Scope,
  ownerId: string,
  email: string,
): Promise<string | null> {
  const [row] = await runInTenantScope({ ...core, userId: ownerId }, () =>
    withTenantDb((tx) =>
      tx
        .select({ publicId: schema.invitations.publicId })
        .from(schema.invitations)
        .where(
          and(
            eq(schema.invitations.orgId, core.orgId),
            eq(schema.invitations.email, email),
            eq(schema.invitations.status, "declined"),
          ),
        )
        .limit(1),
    ),
  );
  return row?.publicId ?? null;
}

type InvitationTokens = {
  token: string;
  expiredToken: string;
  declinedToken: string;
};

/** The three invitations the `invite` page answers differently. */
async function seedInvitations(
  core: Scope,
  ownerId: string,
): Promise<InvitationTokens> {
  const token = await sendInvitation(core, ownerId, INVITATIONS.open);

  // No capability moves an invitation's expiry into the past, so the expired
  // one is a pending invitation whose expiry is set a day back through the
  // typed schema, in the organization's tenant scope (invitations is org_only
  // under RLS). A second run finds it still pending and sets it again.
  const expiredToken = await sendInvitation(core, ownerId, INVITATIONS.expired);
  await runInTenantScope({ ...core, userId: ownerId }, () =>
    withTenantDb((tx) =>
      tx
        .update(schema.invitations)
        .set({
          expiresAt: new Date(Date.now() - EXPIRED_BY_MS),
          updatedAt: new Date(),
          updatedById: ownerId,
        })
        .where(
          and(
            eq(schema.invitations.orgId, core.orgId),
            eq(schema.invitations.publicId, expiredToken),
          ),
        ),
    ),
  );

  // decline_member_invite lets an organization Owner decline on the invitee's
  // behalf, so no account is needed for the declined one. The owner declines
  // from the organization, with no workspace, as the app does.
  let declinedToken = await declinedInvitation(
    core,
    ownerId,
    INVITATIONS.declined,
  );
  if (declinedToken === null) {
    const pending = await sendInvitation(core, ownerId, INVITATIONS.declined);
    await invoke(
      orgMemberInviteDecline.name,
      { invitationPublicId: pending },
      ctxFor(ownerId, core.orgId, ORG_ONLY_WORKSPACE_ID),
    );
    declinedToken = pending;
  }

  log("invitations seeded", { token, expiredToken, declinedToken });
  return { token, expiredToken, declinedToken };
}

// ── Entry ─────────────────────────────────────────────────────────────────

function requireAccount(
  accounts: ReadonlyMap<PersonaKey, Account>,
  key: PersonaKey,
): Account {
  const account = accounts.get(key);
  if (!account) throw new SeedError(`persona ${key} has no account`);
  return account;
}

async function main(): Promise<void> {
  const ownerId = await ownerUserId();
  const core = await coreScope();

  const accounts = new Map<PersonaKey, Account>();
  for (const persona of PERSONAS) {
    if (persona.email === null) continue;
    const userId = await seedAccount(persona.email, persona.name);
    accounts.set(persona.key, { email: persona.email, userId });
  }

  for (const persona of PERSONAS) {
    const account = accounts.get(persona.key);
    if (!account) continue;
    if (persona.orgRole !== null) {
      await seedOrgMembership(
        core,
        ownerId,
        persona.key,
        account,
        persona.orgRole,
      );
    }
    if (persona.workspaceRole !== null) {
      await seedWorkspaceRole(
        core,
        ownerId,
        account.userId,
        persona.workspaceRole,
      );
    }
  }

  await seedEmptyWorkspace(core, ownerId, accounts);
  await seedOutsideOrg(requireAccount(accounts, "outsider").userId);
  const ids = await seedCaptureIds(core, ownerId);
  const invitations = await seedInvitations(core, ownerId);

  const record: PersonasRecord = {
    schema: 1,
    orgSlug: SEED.orgSlug,
    workspaceSlug: SEED.workspaceSlug,
    emptyWorkspaceSlug: EMPTY_WORKSPACE.slug,
    outsideOrgSlug: OUTSIDE_ORG.slug,
    outsideWorkspaceSlug: OUTSIDE_ORG.workspaceSlug,
    values: {
      ...ids.values,
      ...invitations,
      org: SEED.orgSlug,
      ws: SEED.workspaceSlug,
      step: FIRST_REGISTER_STEP,
      // The verify page names the address a link went to; any seeded
      // person's will do, and marcus is the design's default viewer.
      email: requireAccount(accounts, "marcus").email,
    },
    missing: {
      ...ids.missing,
      mandate: MANDATE_MISSING,
      record: RECORD_MISSING,
      tool: TOOL_MISSING,
    },
    personas: Object.fromEntries(accounts),
  };
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(
    PERSONAS_RECORD,
    `${JSON.stringify(personasRecordSchema.parse(record), null, 2)}\n`,
  );
  log("done", { record: PERSONAS_RECORD });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("[seed:audit] failed", error);
    process.exit(1);
  },
);
