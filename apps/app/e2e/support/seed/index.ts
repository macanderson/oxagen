// The e2e seed (ARCHITECTURE.md §5): exactly what the three specs read.
//
//   1. one user, owner@e2e.oxagen.test, through Better Auth's sign-up API,
//      followed by a credential sign-in through the same API — the process
//      exits non-zero unless that sign-in returns a session, so a build the
//      owner cannot sign in to fails here, before Playwright starts;
//   2. one organization, e2e-org, with its workspace, core, through the
//      kernel's create_org (owner membership, IAM bootstrap and the first
//      workspace come with it);
//   3. one ledger run with two events, through @oxagen/run-ledger's RunStore,
//      so /{org}/{ws}/runs/{run} has a title to load. The run's identity is
//      resolved the way admission resolves it: an agent registered on a
//      runtime through the kernel (ADR-192; its delegated principal and its
//      first version come with it), the
//      owner's human principal, a pinned authorization snapshot from
//      @oxagen/iam, and a retention policy version.
//
// Nothing else: no invitation, no billing row. Idempotent — keyed on the
// email, the org slug, the agent slug and the presence of a V2 run in the
// workspace — so two runs leave the same row counts. Writes go through
// package APIs only; the one table no package writes today,
// evidence.retention_policy_versions, is written through @oxagen/database's
// typed schema inside the tenant transaction.
//
// Runs under E2E_TEST=true (the package.json script sets it): the sign-in
// self-check must see the same relaxation the e2e webServer runs with, since
// sign-up leaves emailVerified false and packages/auth requires verification
// off that flag (auth.ts, local-env.ts). Never imported by src/ (INV-07).
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { auth } from "@oxagen/auth/server";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { createAgentRunAuthorizationSnapshot } from "@oxagen/iam";
import type { CapabilityContext } from "@oxagen/oxagen";
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { runtimeCreate } from "@oxagen/oxagen/contracts/runtime.create";
import { invoke } from "@oxagen/oxagen/kernel";
import {
  createPostgresRunStore,
  digestOfCanonicalJson,
  parseRunSpecV2,
  TERMINAL_EVENT_TYPE,
} from "@oxagen/run-ledger";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { AUTH_DIR, SEED, SEED_RECORD } from "../index";

/** The agent the seeded run is attributed to; registered through the kernel. */
const AGENT = { slug: "e2e-agent", name: "E2E agent" } as const;

/** The runtime the seeded agent runs on (ADR-192). */
const RUNTIME = { slug: "e2e-runtime", name: "E2E runtime" } as const;

/** The goal on the seeded run; what the Run header prints. */
const RUN_GOAL = "Seeded run for the e2e suite";

/** The engine identity pinned on the seeded attempt. */
const ENGINE = {
  name: "stella",
  version: "0.0.0",
  buildDigest: digestOfCanonicalJson({ seed: "e2e" }),
} as const;

class SeedError extends Error {}

function log(step: string, detail: Record<string, unknown> = {}): void {
  console.log(`[seed:e2e] ${step}`, JSON.stringify(detail));
}

// ── 1. The owner: sign-up, then the sign-in self-check ─────────────────────

function isAlreadyRegistered(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { body?: { code?: string }; message?: string };
  return /USER_ALREADY_EXISTS/i.test(
    e.body?.code ?? (e.message ?? "").replace(/[\s.-]+/g, "_"),
  );
}

async function seedOwner(): Promise<{ userId: string }> {
  try {
    await auth.api.signUpEmail({
      body: { email: SEED.email, password: SEED.password, name: SEED.name },
    });
    log("owner signed up", { email: SEED.email });
  } catch (error) {
    if (!isAlreadyRegistered(error)) throw error;
    log("owner already registered", { email: SEED.email });
  }
  // The self-check: the harness is worthless if the seeded owner cannot sign
  // in, and a sign-in that fails here fails for the same reason it would fail
  // in login.spec.ts, one step earlier and with the server's own error. The
  // session it mints is signed out again, so a seed leaves no session behind.
  const { headers, response: signedIn } = await auth.api.signInEmail({
    body: { email: SEED.email, password: SEED.password },
    returnHeaders: true,
  });
  if (signedIn.token.length === 0) {
    throw new SeedError(
      `credential sign-in for ${SEED.email} returned no session token`,
    );
  }
  await auth.api.signOut({
    headers: new Headers({ cookie: cookieFromSetCookie(headers) }),
  });
  log("owner sign-in verified", { userId: signedIn.user.id });
  return { userId: signedIn.user.id };
}

/** The `cookie` request header that presents every cookie a response set. */
function cookieFromSetCookie(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0] ?? "")
    .filter((pair) => pair.length > 0)
    .join("; ");
}

// ── 2. The organization and its workspace ──────────────────────────────────

/**
 * A pre-tenant kernel context for the signed-in owner (create_org is
 * scoped: false). No `opts.surface` is claimed on any invoke, the rule the
 * app's own seam follows (src/server/kernel.ts): create_org is not exposed on
 * an "app" surface, and the surface check is for the API and MCP adapters.
 */
function pretenantCtx(userId: string): CapabilityContext {
  return {
    orgId: "",
    workspaceId: "",
    userId,
    apiKeyId: null,
    requestId: randomUUID(),
    surface: "app",
    messageId: null,
  };
}

async function findOrg(): Promise<{
  orgId: string;
  workspaceId: string;
} | null> {
  // tenancy: system bypass — the seed resolves the org it is about to create
  // or reuse before any tenant scope exists, the way identity resolution does.
  return withSystemDb(async (tx) => {
    const [org] = await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, SEED.orgSlug))
      .limit(1);
    if (!org) return null;
    const [ws] = await tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, org.id),
          eq(schema.workspaces.slug, SEED.workspaceSlug),
        ),
      )
      .limit(1);
    if (!ws) {
      throw new SeedError(
        `organization ${SEED.orgSlug} exists without its workspace ${SEED.workspaceSlug}`,
      );
    }
    return { orgId: org.id, workspaceId: ws.id };
  });
}

async function seedOrg(
  userId: string,
): Promise<{ orgId: string; workspaceId: string }> {
  const existing = await findOrg();
  if (existing) {
    log("organization already exists", { slug: SEED.orgSlug });
    return existing;
  }
  await invoke(
    organizationCreate.name,
    {
      name: SEED.orgName,
      slug: SEED.orgSlug,
      workspace: { name: SEED.workspaceName, slug: SEED.workspaceSlug },
    },
    pretenantCtx(userId),
  );
  log("organization created", { slug: SEED.orgSlug });
  const created = await findOrg();
  if (!created) {
    throw new SeedError(
      `create_org returned but ${SEED.orgSlug} is not readable`,
    );
  }
  return created;
}

// ── 3. The ledger run ──────────────────────────────────────────────────────

type Scope = { orgId: string; workspaceId: string };

function tenantCtx(scope: Scope, userId: string): CapabilityContext {
  return { ...pretenantCtx(userId), ...scope };
}

/** The agent the run is attributed to, with its delegated principal and v1. */
async function seedAgent(
  scope: Scope,
  userId: string,
): Promise<{
  agentId: string;
  agentPrincipalId: string;
  agentVersionId: string;
  agentVersionChecksum: string;
}> {
  const read = () =>
    withTenantDb(async (tx) => {
      const [agent] = await tx
        .select({
          id: schema.agents.id,
          principalId: schema.agents.principalId,
        })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, scope.workspaceId),
            eq(schema.agents.slug, AGENT.slug),
          ),
        )
        .limit(1);
      if (!agent) return null;
      const [version] = await tx
        .select({
          id: schema.agentVersions.id,
          config: schema.agentVersions.config,
        })
        .from(schema.agentVersions)
        .where(
          and(
            eq(schema.agentVersions.agentId, agent.id),
            eq(schema.agentVersions.version, 1),
          ),
        )
        .limit(1);
      if (!agent.principalId || !version) {
        throw new SeedError(`agent ${AGENT.slug} has no principal or no v1`);
      }
      return {
        agentId: agent.id,
        agentPrincipalId: agent.principalId,
        agentVersionId: version.id,
        // register_agent leaves the v1 checksum null; the run pins a digest
        // over the config it was admitted against.
        agentVersionChecksum: digestOfCanonicalJson(version.config),
      };
    });

  const existing = await read();
  if (existing) {
    log("agent already exists", { slug: AGENT.slug });
    return existing;
  }
  const runtimeId = await seedRuntime(scope, userId);
  await invoke(
    agentRegister.name,
    {
      name: AGENT.name,
      slug: AGENT.slug,
      harness: "claude-code",
      runtimeId,
    },
    tenantCtx(scope, userId),
  );
  log("agent registered", { slug: AGENT.slug, runtime: RUNTIME.slug });
  const created = await read();
  if (!created) {
    throw new SeedError(
      `register_agent returned but ${AGENT.slug} is not readable`,
    );
  }
  return created;
}

/**
 * The runtime the agent is registered on, by its public id. Read first, so a
 * seed that stopped after naming it does not trip `runtime_slug_taken`.
 */
async function seedRuntime(scope: Scope, userId: string): Promise<string> {
  const read = () =>
    withTenantDb(async (tx) => {
      const [row] = await tx
        .select({ publicId: schema.runtimes.publicId })
        .from(schema.runtimes)
        .where(
          and(
            eq(schema.runtimes.workspaceId, scope.workspaceId),
            eq(schema.runtimes.slug, RUNTIME.slug),
          ),
        )
        .limit(1);
      return row?.publicId ?? null;
    });
  const existing = await read();
  if (existing !== null) return existing;
  await invoke(
    runtimeCreate.name,
    { name: RUNTIME.name, slug: RUNTIME.slug },
    tenantCtx(scope, userId),
  );
  const created = await read();
  if (created === null) {
    throw new SeedError(
      `create_runtime returned but ${RUNTIME.slug} is not readable`,
    );
  }
  return created;
}

/** The owner's human principal in the org (bootstrapped by create_org). */
async function ownerPrincipalId(scope: Scope, userId: string): Promise<string> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, scope.orgId),
          eq(schema.principals.parentUserId, userId),
          eq(schema.principals.kind, "human"),
        ),
      )
      .limit(1),
  );
  if (!row) throw new SeedError("the owner has no human principal in the org");
  return row.id;
}

/**
 * The retention policy version the run pins. One digest-only policy per
 * workspace: the digest unique index makes a second seed resolve to the same
 * row.
 */
async function retentionPolicy(
  scope: Scope,
  userId: string,
): Promise<{ rowId: string; publicId: string; digest: string }> {
  const policy = {
    mode: "digest_only",
    retained_content_classes: [],
    ttl_days: 30,
  };
  const digest = digestOfCanonicalJson(policy);
  return withTenantDb(async (tx) => {
    await tx
      .insert(schema.retentionPolicyVersions)
      .values({
        ...scope,
        version: 1,
        mode: policy.mode,
        retainedContentClasses: policy.retained_content_classes,
        ttlDays: policy.ttl_days,
        policyDigest: digest,
        createdById: userId,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select({
        id: schema.retentionPolicyVersions.id,
        publicId: schema.retentionPolicyVersions.publicId,
      })
      .from(schema.retentionPolicyVersions)
      .where(
        and(
          eq(schema.retentionPolicyVersions.orgId, scope.orgId),
          eq(schema.retentionPolicyVersions.workspaceId, scope.workspaceId),
          eq(schema.retentionPolicyVersions.policyDigest, digest),
        ),
      )
      .limit(1);
    if (!row) throw new SeedError("retention policy version is not readable");
    return { rowId: row.id, publicId: row.publicId, digest };
  });
}

/** The public id of a V2 ledger run already in the workspace, if any. */
async function existingRunPublicId(scope: Scope): Promise<string | null> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ publicId: schema.agentRuns.publicId })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.orgId, scope.orgId),
          eq(schema.agentRuns.workspaceId, scope.workspaceId),
          eq(schema.agentRuns.specVersion, 2),
        ),
      )
      .limit(1),
  );
  return row?.publicId ?? null;
}

async function seedRun(scope: Scope, userId: string): Promise<string> {
  const existing = await existingRunPublicId(scope);
  if (existing) {
    log("run already exists", { runPublicId: existing });
    return existing;
  }
  const agent = await seedAgent(scope, userId);
  const initiatingPrincipalId = await ownerPrincipalId(scope, userId);
  const snapshot = await createAgentRunAuthorizationSnapshot({
    ...scope,
    initiatingPrincipalId,
    agentPrincipalId: agent.agentPrincipalId,
  });
  const retention = await retentionPolicy(scope, userId);

  const spec = parseRunSpecV2({
    version: 2,
    run_kind: "general",
    goal: RUN_GOAL,
    engine_policy: {
      requested_engine: ENGINE.name,
      allowed_engine_versions: [ENGINE.version],
      model_policy_ref: "e2e",
      max_steps: 1,
      max_attempts: 1,
    },
    actor_binding: {
      initiating_principal_id: initiatingPrincipalId,
      agent_principal_id: agent.agentPrincipalId,
      agent_id: agent.agentId,
      agent_version_id: agent.agentVersionId,
      agent_version_checksum: agent.agentVersionChecksum,
    },
    authorization_snapshot_ref: {
      snapshot_id: snapshot.snapshotId,
      snapshot_digest: snapshot.snapshotDigest,
      grant_ceiling_digest: snapshot.grantCeilingDigest,
      deny_generation_at_admission: {
        org: String(snapshot.denyGenerationAtAdmission.org),
        workspace: String(snapshot.denyGenerationAtAdmission.workspace),
      },
      resolved_at: snapshot.resolvedAt,
    },
    workspace_policy: { sandbox_required: true },
    context_policy: {
      provider_allowlist: [],
      max_frames: 0,
      max_tokens: 0,
      retention_policy_id: retention.publicId,
      retention_policy_digest: retention.digest,
    },
    tool_policy: { allowlist: [], risk_ceiling: "low" },
  });

  // The seal writes the attempt's archive segment before the row that names
  // it, so a sealing store needs an archive; `createPostgresRunStore()` with
  // none refuses. `ledgerStore()` in @oxagen/inngest-functions is the same
  // wiring for the durable jobs. The read paths (the live adapter, run.fork,
  // run-read) construct without one because they never seal.
  const store = createPostgresRunStore({ archive: evidenceStore() });
  const run = await store.createRun({
    ...scope,
    surface: "external",
    spec,
    retentionPolicyRowId: retention.rowId,
    repositoryBindingRowId: null,
  });
  const attempt = await store.createAttempt({
    runId: run.runId,
    producerId: "seed:e2e",
    engine: ENGINE,
  });
  // Two events: the admission receipt, then the terminal receipt the seal
  // appends in the same transaction that closes the run.
  const observedAt = new Date().toISOString();
  await store.appendAttemptBatch({
    attemptId: attempt.attemptId,
    events: [
      {
        attemptSeq: 1,
        eventType: "admission.run_admitted",
        observedAt,
        payload: {
          attempt_public_id: attempt.attemptPublicId,
          attempt_number: attempt.attemptNumber,
          max_attempts: attempt.maxAttempts,
          spec_digest: run.specDigest,
          authorization_snapshot_digest: snapshot.snapshotDigest,
          grant_ceiling_digest: snapshot.grantCeilingDigest,
          engine_name: ENGINE.name,
          engine_version: ENGINE.version,
          engine_build_digest: ENGINE.buildDigest,
        },
      },
    ],
  });
  await store.sealAttempt({
    attemptId: attempt.attemptId,
    terminalStatus: "completed",
    sealerId: "seed:e2e",
    terminalEvent: {
      attemptSeq: 2,
      eventType: TERMINAL_EVENT_TYPE,
      observedAt,
      payload: { terminal_status: "completed" },
    },
  });
  log("run created", { runPublicId: run.publicId });
  return run.publicId;
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { userId } = await seedOwner();
  const scope = await seedOrg(userId);
  const runPublicId = await runInTenantScope({ ...scope, userId }, () =>
    seedRun(scope, userId),
  );
  const record = { runPublicId };
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(SEED_RECORD, `${JSON.stringify(record, null, 2)}\n`);
  log("done", { record: SEED_RECORD });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("[seed:e2e] failed", error);
    process.exit(1);
  },
);
