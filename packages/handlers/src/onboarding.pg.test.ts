// The onboarding gate against a real Postgres (#2967): an owner creates an
// organization and the gate opens on its first workspace; a registered agent
// gets a single-use enrollment token; two machines present it at once and
// exactly one becomes the host; the first frame that host ingests unlocks
// the gate and stamps the agent; a provisional workspace refuses a context
// record until the main repository is bound; the gate refuses to skip the
// run step; concurrent binds leave one main repository; the three
// role-checked writes refuse a workspace Member and a
// user outside the organization; a revoked host gives its agent key up to a
// new enrollment. Runs wherever DATABASE_URL points at a
// migrated database (CI's `test` job; a local run without one is skipped).
// Every row it writes is removed in afterAll.
import { generateKeyPairSync } from "node:crypto";
import {
  type CapabilityContext,
  HandlerError,
  isHandlerError,
} from "@oxagen/oxagen";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { tachoHostEnroll } from "@oxagen/oxagen/contracts/tacho.host.enroll";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import {
  GENESIS_CURSOR,
  type ChainCursor,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertTachoEvents: vi.fn(),
  emitSecurityEvent: vi.fn(),
  emitSecurityEventAsync: vi.fn(async () => undefined),
}));
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...original, insertTachoEvents: mocks.insertTachoEvents };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

import { contextRecordPublishHandler } from "./context.record.publish";
import { hashEnrollmentToken } from "./lib/onboarding";
import { onboardingAdvanceHandler } from "./onboarding.advance";
import { onboardingFirstFrameGetHandler } from "./onboarding.first_frame.get";
import { onboardingStateGetHandler } from "./onboarding.state.get";
import { organizationCreateHandler } from "./org.create";
import {
  createMainRepositoryBindHandler,
  type MainRepositoryDeps,
} from "./repository.main.bind";
import { tachoEnrollmentRevokeHandler } from "./tacho.enrollment.revoke";
import { tachoEnrollmentTokenCreateHandler } from "./tacho.enrollment_token.create";
import { tachoEventsIngestHandler } from "./tacho.events.ingest";
import { tachoHostEnrollHandler } from "./tacho.host.enroll";

// Two of this file's tests call organizationCreateHandler directly — the same
// IAM + workspace bootstrap org.create.pg.test.ts measures at 5367-6505ms on
// a loaded CI runner (~3.4s idle, MEASURED against local Postgres in this
// PR). "create_org opens the gate at wrap…" and "the first frame the host
// ingests unlocks the gate…" measured 3157ms and 2177ms here on an idle
// machine — already within ~1.8s of vitest's 5000ms default, the same margin
// that timed out for #3086. Same root cause: role_grants is seeded per-org
// from the capability catalog, not reused across orgs, so there is no
// per-test-duplicated global seed to fix here either — the cost is inherent
// to provisioning a new org's IAM. Matched to org.create.pg.test.ts's budget
// (not schema.setup.test.ts's) since both exercise the identical path.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const enabled = Boolean(process.env.DATABASE_URL);
const DAY_MS = 24 * 60 * 60 * 1000;

const refusal = (code: HandlerError["code"], reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === code && e.reason === reason;

describe.skipIf(!enabled)("the onboarding gate against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const ownerId = crypto.randomUUID();
  const strangerId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const slug = `g2967-${tag}`;
  let orgId = "";
  let workspaceId = "";
  let agentId = "";
  let agentPublicId = "";
  let agentKey = "";
  let hostPublicId = "";
  let hostApiKeyId = "";
  let token = "";
  const PEM = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

  const ctxFor = (userId: string | null): CapabilityContext => ({
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  });
  const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
    runInTenantScope({ orgId, workspaceId }, fn);

  beforeAll(async () => {
    vi.stubEnv("TACHO_ENROLLMENT_SIGNING_SECRET", `secret-${tag}`);
    vi.stubEnv("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", PEM.replace(/\n/g, "\\n"));
    vi.stubEnv("TACHO_INGEST_ENDPOINTS", "https://api.example.test/v1/tacho");
    await withSystemDb((tx) =>
      tx.insert(schema.users).values([
        { id: ownerId, email: `g2967-${tag}@handlers.test`, status: "active" },
        {
          id: strangerId,
          email: `g2967-${tag}-stranger@handlers.test`,
          status: "active",
        },
        {
          id: memberId,
          email: `g2967-${tag}-member@handlers.test`,
          status: "active",
        },
      ]),
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (orgId) {
      await withSystemDb(async (tx) => {
        const del = async (
          table: Parameters<typeof tx.delete>[0],
          col: unknown,
        ) => tx.delete(table).where(eq(col as never, orgId));
        await del(schema.tachoSessionModels, schema.tachoSessionModels.orgId);
        await del(schema.tachoSessionFiles, schema.tachoSessionFiles.orgId);
        await del(
          schema.tachoSessionCommands,
          schema.tachoSessionCommands.orgId,
        );
        await del(schema.tachoSessions, schema.tachoSessions.orgId);
        await del(
          schema.tachoControlCommands,
          schema.tachoControlCommands.orgId,
        );
        await del(
          schema.tachoEnrollmentTokens,
          schema.tachoEnrollmentTokens.orgId,
        );
        await del(schema.tachoHosts, schema.tachoHosts.orgId);
        await del(schema.apiKeys, schema.apiKeys.orgId);
        // The record's active_version_id references a version: clear the
        // pointer, then the versions, then the records.
        await tx
          .update(schema.contextRecords)
          .set({ activeVersionId: null })
          .where(eq(schema.contextRecords.orgId, orgId));
        await del(
          schema.contextRecordVersions,
          schema.contextRecordVersions.orgId,
        );
        await del(schema.contextRecords, schema.contextRecords.orgId);
        await del(
          schema.repositoryBindingHeads,
          schema.repositoryBindingHeads.orgId,
        );
        await del(schema.repositoryBindings, schema.repositoryBindings.orgId);
        await del(schema.sourceConnections, schema.sourceConnections.orgId);
        await del(schema.onboardingState, schema.onboardingState.orgId);
        const agentIds = (
          await tx
            .select({ id: schema.agents.id })
            .from(schema.agents)
            .where(eq(schema.agents.orgId, orgId))
        ).map((r) => r.id);
        if (agentIds.length > 0) {
          await tx
            .delete(schema.agentVersions)
            .where(inArray(schema.agentVersions.agentId, agentIds));
        }
        await del(schema.agents, schema.agents.orgId);
        const workspaceIds = (
          await tx
            .select({ id: schema.workspaces.id })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.orgId, orgId))
        ).map((r) => r.id);
        if (workspaceIds.length > 0) {
          await tx
            .delete(schema.workspaceUsers)
            .where(inArray(schema.workspaceUsers.workspaceId, workspaceIds));
        }
        await del(schema.mcpRegistries, schema.mcpRegistries.orgId);
        await del(schema.environments, schema.environments.orgId);
        await del(schema.workspaces, schema.workspaces.orgId);
        await del(schema.roleGrants, schema.roleGrants.orgId);
        await del(
          schema.principalRoleAssignments,
          schema.principalRoleAssignments.orgId,
        );
        await del(schema.principals, schema.principals.orgId);
        await del(schema.roles, schema.roles.orgId);
        await del(schema.securityEvents, schema.securityEvents.orgId);
        // create_org writes the $5 signup grant on its own bootstrap
        // transaction (packages/billing/src/grants.ts grantSignupCredits), so
        // every org this file creates holds a ledger row, a free_grant lot and
        // a balance mirror. All three carry an FK to org.organizations, so the
        // org delete below fails on credit_balances_org_id_organizations_id_fk
        // unless they go first. Mirrors org.create.pg.test.ts.
        await del(schema.creditLots, schema.creditLots.orgId);
        await del(schema.creditLedger, schema.creditLedger.orgId);
        await del(schema.creditBalances, schema.creditBalances.orgId);
        await del(schema.orgUsers, schema.orgUsers.orgId);
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      });
    }
    await withSystemDb((tx) =>
      tx
        .delete(schema.users)
        .where(inArray(schema.users.id, [ownerId, strangerId, memberId])),
    );
    await closeDatabase();
  });

  // create_org runs the whole IAM and workspace bootstrap in one system
  // transaction; under coverage, with the other pg files bootstrapping
  // organizations over the same shared IAM rows, it outlasts vitest's 5s
  // default.
  it("create_org opens the gate at wrap on the first workspace with a 14-day provisional window", async () => {
    const out = await organizationCreateHandler(
      organizationCreate.input.parse({
        name: `G2967 ${tag}`,
        slug,
        workspace: { name: "Core", slug: "core" },
      }),
      { ...ctxFor(ownerId), orgId: "", workspaceId: "" },
    );
    const org = await withSystemDb((tx) =>
      tx.query.organizations.findFirst({
        where: eq(schema.organizations.slug, slug),
      }),
    );
    expect(org).toBeDefined();
    if (!org) return;
    orgId = org.id;
    const workspace = await withSystemDb((tx) =>
      tx.query.workspaces.findFirst({
        where: eq(schema.workspaces.publicId, out.workspace.publicId),
      }),
    );
    expect(workspace).toBeDefined();
    if (!workspace) return;
    workspaceId = workspace.id;

    const [gate] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.onboardingState)
        .where(eq(schema.onboardingState.orgId, orgId)),
    );
    expect(gate).toMatchObject({
      workspaceId,
      step: "wrap",
      firstFrameAt: null,
      firstRunId: null,
      mainRepoBoundAt: null,
      detectedRepository: null,
    });
    expect(gate?.provisionalUntil.getTime()).toBe(
      org.createdAt.getTime() + 14 * DAY_MS,
    );

    const state = await onboardingStateGetHandler({}, ctxFor(ownerId));
    expect(state).toMatchObject({
      step: "wrap",
      workspace: { id: out.workspace.publicId, slug: "core" },
      provisional: { mainRepoBoundAt: null, detectedRepository: null },
    });
    expect(
      await onboardingStateGetHandler({}, { ...ctxFor(ownerId), orgId: "" }),
    ).toMatchObject({ step: "organization", workspace: null });

    // A Member of the workspace: an org_users row and the workspace Member
    // role create_org seeded, the shape an accepted invitation leaves.
    const [memberRole] = await withSystemDb((tx) =>
      tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.orgId, orgId),
            eq(schema.roles.scopeKind, "workspace"),
            eq(schema.roles.name, "Member"),
          ),
        )
        .limit(1),
    );
    expect(memberRole).toBeDefined();
    await withSystemDb(async (tx) => {
      await tx.insert(schema.orgUsers).values({
        orgId,
        userId: memberId,
        role: "Member",
        joinedAt: new Date(),
      });
      const [principal] = await tx
        .insert(schema.principals)
        .values({
          orgId,
          kind: "human",
          displayName: "Member",
          parentUserId: memberId,
        })
        .returning({ id: schema.principals.id });
      await tx.insert(schema.principalRoleAssignments).values({
        principalId: principal?.id ?? "",
        roleId: memberRole?.id ?? "",
        orgId,
        workspaceId,
      });
    });
  }, 30_000);

  it("advance_onboarding moves wrap → run for the owner, refuses a Member and a stranger, and refuses to skip the run step", async () => {
    await expect(
      inScope(() => onboardingAdvanceHandler({ to: "run" }, ctxFor(memberId))),
    ).rejects.toSatisfy(refusal("forbidden", "org_role_required"));
    await expect(
      inScope(() =>
        onboardingAdvanceHandler({ to: "run" }, ctxFor(strangerId)),
      ),
    ).rejects.toSatisfy(refusal("forbidden", "org_role_required"));
    await expect(
      inScope(() => onboardingAdvanceHandler({ to: "run" }, ctxFor(null))),
    ).rejects.toSatisfy(refusal("forbidden", "no_principal"));
    await expect(
      inScope(() =>
        onboardingAdvanceHandler({ to: "unlocked" }, ctxFor(ownerId)),
      ),
    ).rejects.toSatisfy(refusal("conflict", "first_frame_required"));

    const moved = await inScope(() =>
      onboardingAdvanceHandler({ to: "run" }, ctxFor(ownerId)),
    );
    expect(moved.step).toBe("run");
    const again = await inScope(() =>
      onboardingAdvanceHandler({ to: "run" }, ctxFor(ownerId)),
    );
    expect(again).toEqual(moved);
    const back = await inScope(() =>
      onboardingAdvanceHandler({ to: "wrap" }, ctxFor(ownerId)),
    );
    expect(back.step).toBe("wrap");
    expect((await onboardingStateGetHandler({}, ctxFor(ownerId))).step).toBe(
      "wrap",
    );
  });

  it("create_enrollment_token mints a token for a registered agent, shown once and stored as a digest", async () => {
    const [org] = await withSystemDb((tx) =>
      tx
        .select({ namespace: schema.organizations.namespace })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId)),
    );
    const [ws] = await withSystemDb((tx) =>
      tx
        .select({ namespace: schema.workspaces.namespace })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId)),
    );
    const [principal] = await withSystemDb((tx) =>
      tx
        .insert(schema.principals)
        .values({
          orgId,
          workspaceId,
          kind: "agent",
          displayName: "Release manager",
          parentUserId: ownerId,
        })
        .returning({ id: schema.principals.id }),
    );
    const [agent] = await withSystemDb((tx) =>
      tx
        .insert(schema.agents)
        .values({
          orgId,
          workspaceId,
          slug: "release-manager",
          name: "Release manager",
          agentType: "custom",
          principalId: principal?.id ?? null,
          createdById: ownerId,
          updatedById: ownerId,
        })
        .returning({
          id: schema.agents.id,
          publicId: schema.agents.publicId,
          registeredVia: schema.agents.registeredVia,
        }),
    );
    expect(agent?.registeredVia).toBe("ui");
    agentId = agent?.id ?? "";
    agentPublicId = agent?.publicId ?? "";
    agentKey = `${org?.namespace}.${ws?.namespace}.release-manager`;

    for (const userId of [memberId, strangerId]) {
      await expect(
        inScope(() =>
          tachoEnrollmentTokenCreateHandler(
            { agentId: agentPublicId, ttlMinutes: 30 },
            ctxFor(userId),
          ),
        ),
      ).rejects.toSatisfy(refusal("forbidden", "org_role_required"));
    }
    await expect(
      inScope(() =>
        tachoEnrollmentTokenCreateHandler(
          { agentId: "agt_0000000000", ttlMinutes: 30 },
          ctxFor(ownerId),
        ),
      ),
    ).rejects.toSatisfy(refusal("not_found", "agent_not_found"));

    const before = Date.now();
    const issued = await inScope(() =>
      tachoEnrollmentTokenCreateHandler(
        { agentId: agentPublicId, ttlMinutes: 30 },
        ctxFor(ownerId),
      ),
    );
    token = issued.token;
    expect(issued).toMatchObject({
      agentId: agentPublicId,
      agentKey,
      enrollCommand: `oxagen agent enroll --token ${token}`,
    });
    expect(token).toMatch(/^oxe_1time_[0-9a-hjkmnp-tv-z]{26}$/);
    const expires = Date.parse(issued.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(expires).toBeLessThan(before + 31 * 60_000);

    const [row] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoEnrollmentTokens)
        .where(eq(schema.tachoEnrollmentTokens.publicId, issued.tokenId)),
    );
    expect(row).toMatchObject({
      agentId,
      issuedToUserId: ownerId,
      usedAt: null,
      usedByHostId: null,
      rejectedCount: 0,
    });
    expect(row?.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("enroll_host consumes the token once under two concurrent presentations, binds the host to the agent, and records the git remote", async () => {
    const facts = (hostname: string) =>
      tachoHostEnroll.input.parse({
        token,
        hostname,
        osUser: "dev",
        platform: "darwin",
        devicePublicKey: `ed25519:${Buffer.alloc(32, 7).toString("base64")}`,
        harnesses: ["claude-code"],
        repositoryRemote: "git@github.com:acme/widgets.git",
      });
    const bare = { ...ctxFor(null), orgId: "", workspaceId: "" };
    const results = await Promise.allSettled([
      tachoHostEnrollHandler(facts("mbp-one.local"), bare),
      tachoHostEnrollHandler(facts("mbp-two.local"), bare),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.status === "rejected" ? lost[0].reason : null).toSatisfy(
      refusal("conflict", "token_used"),
    );

    const doc = won[0]?.status === "fulfilled" ? won[0].value : null;
    expect(doc).toMatchObject({
      agentId: agentPublicId,
      agentKey,
      orgSlug: slug,
      workspaceSlug: "core",
    });
    expect(doc?.apiKey).toMatch(/^ox_/);
    hostPublicId = doc?.hostEnrollmentId ?? "";

    const [host] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoHosts)
        .where(eq(schema.tachoHosts.orgId, orgId)),
    );
    expect(host).toMatchObject({
      publicId: hostPublicId,
      agentKey,
      agentId,
      status: "active",
    });
    hostApiKeyId = host?.apiKeyId ?? "";

    const [tokenRow] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoEnrollmentTokens)
        .where(eq(schema.tachoEnrollmentTokens.orgId, orgId)),
    );
    expect(tokenRow?.usedAt).not.toBeNull();
    expect(tokenRow?.usedByHostId).toBe(host?.id);

    // The losing presentation was counted whether it lost before or after
    // the row lock; a third presentation is refused and counted as well.
    await expect(
      tachoHostEnrollHandler(facts("mbp-three.local"), bare),
    ).rejects.toSatisfy(refusal("conflict", "token_used"));
    await expect(
      tachoHostEnrollHandler(
        {
          ...facts("mbp-four.local"),
          token: "oxe_1time_zzzzzzzzzzzzzzzzzzzzzzzzzz",
        },
        bare,
      ),
    ).rejects.toSatisfy(refusal("not_found", "token_unknown"));
    const [counted] = await withSystemDb((tx) =>
      tx
        .select({ rejectedCount: schema.tachoEnrollmentTokens.rejectedCount })
        .from(schema.tachoEnrollmentTokens)
        .where(eq(schema.tachoEnrollmentTokens.orgId, orgId)),
    );
    expect(counted?.rejectedCount).toBe(2);

    // An expired token is refused before anything is minted, and counted.
    const expiredToken = "oxe_1time_expired0000000000000000000".slice(0, 36);
    const [expired] = await withSystemDb((tx) =>
      tx
        .insert(schema.tachoEnrollmentTokens)
        .values({
          orgId,
          workspaceId,
          agentId,
          tokenHash: hashEnrollmentToken(expiredToken),
          issuedToUserId: ownerId,
          expiresAt: new Date(Date.now() - 60_000),
        })
        .returning({ id: schema.tachoEnrollmentTokens.id }),
    );
    await expect(
      tachoHostEnrollHandler(
        { ...facts("mbp-five.local"), token: expiredToken },
        bare,
      ),
    ).rejects.toSatisfy(refusal("conflict", "token_expired"));
    const [expiredRow] = await withSystemDb((tx) =>
      tx
        .select({ rejectedCount: schema.tachoEnrollmentTokens.rejectedCount })
        .from(schema.tachoEnrollmentTokens)
        .where(eq(schema.tachoEnrollmentTokens.id, expired?.id ?? "")),
    );
    expect(expiredRow?.rejectedCount).toBe(1);
    const hosts = await withSystemDb((tx) =>
      tx
        .select({ id: schema.tachoHosts.id })
        .from(schema.tachoHosts)
        .where(eq(schema.tachoHosts.orgId, orgId)),
    );
    expect(hosts).toHaveLength(1);

    const state = await onboardingStateGetHandler({}, ctxFor(ownerId));
    expect(state.provisional?.detectedRepository).toEqual({
      provider: "github",
      owner: "acme",
      name: "widgets",
    });
    const wait = await inScope(() =>
      onboardingFirstFrameGetHandler(
        { agentId: agentPublicId, waitMs: 0 },
        ctxFor(ownerId),
      ),
    );
    expect(wait.host?.hostEnrollmentId).toBe(hostPublicId);
    expect(wait.firstFrame).toBeNull();
  });

  it("the first frame the host ingests unlocks the gate, names the run, and stamps the agent as registered via onboarding", async () => {
    const session = sessionUuid(hostPublicId, "sess-1");
    const unsealed = (
      kind: UnsealedTachoEvent["kind"],
      body: Record<string, unknown>,
    ): UnsealedTachoEvent =>
      ({
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "sess-1",
        session_uuid: session,
        root_session_uuid: session,
        ts: "2026-09-15T12:00:30.000Z",
        fidelity: "sdk",
        source: "hook",
        agent: {
          agent_key: agentKey,
          fleet_id: "wrk_1",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
          host_enrollment_id: hostPublicId,
        },
        context: { cwd: "/home/dev/proj" },
        kind,
        body,
      }) as UnsealedTachoEvent;
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      unsealed("agent_start", { session_start_source: "startup" }),
      unsealed("agent_stop", {
        session_outcome: "completed",
        session_end_reason: "other",
      }),
    ]) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }
    mocks.insertTachoEvents.mockResolvedValue(undefined);

    const output = await inScope(() =>
      tachoEventsIngestHandler(
        { schema: "tacho.batch.v1", host_enrollment_id: hostPublicId, events },
        { ...ctxFor(null), apiKeyId: hostApiKeyId },
      ),
    );
    expect(output.accepted).toBe(2);

    const [gate] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.onboardingState)
        .where(eq(schema.onboardingState.orgId, orgId)),
    );
    const [run] = await withSystemDb((tx) =>
      tx
        .select({
          publicId: schema.tachoSessions.publicId,
          agentId: schema.tachoSessions.agentId,
          initiatingPrincipalId: schema.tachoSessions.initiatingPrincipalId,
          initiatingUserId: schema.tachoSessions.initiatingUserId,
          createdAt: schema.tachoSessions.createdAt,
          startedAt: schema.tachoSessions.startedAt,
        })
        .from(schema.tachoSessions)
        .where(eq(schema.tachoSessions.sessionUuid, session)),
    );
    expect(run?.agentId).toBe(agentId);
    // The person who enrolled the host: the owner the token was issued to,
    // through the human principal create_org gave them here (#2951).
    const [ownerPrincipal] = await withSystemDb((tx) =>
      tx
        .select({ id: schema.principals.id })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, orgId),
            eq(schema.principals.parentUserId, ownerId),
            eq(schema.principals.kind, "human"),
          ),
        ),
    );
    expect(ownerPrincipal?.id).toBeDefined();
    expect(run?.initiatingPrincipalId).toBe(ownerPrincipal?.id);
    expect(run?.initiatingUserId).toBe(ownerId);
    expect(gate).toMatchObject({ step: "unlocked", firstRunId: run?.publicId });
    expect(gate?.firstFrameAt).not.toBeNull();
    const [agent] = await withSystemDb((tx) =>
      tx
        .select({ registeredVia: schema.agents.registeredVia })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId)),
    );
    expect(agent?.registeredVia).toBe("onboarding");

    const wait = await inScope(() =>
      onboardingFirstFrameGetHandler(
        { agentId: agentPublicId, waitMs: 0 },
        ctxFor(ownerId),
      ),
    );
    expect(wait.firstFrame?.runId).toBe(run?.publicId);
    // The receipt time is the server's, not the event's ts the host reported.
    expect(run?.startedAt.toISOString()).toBe("2026-09-15T12:00:30.000Z");
    expect(wait.firstFrame?.receivedAt).toBe(run?.createdAt.toISOString());
    expect(wait.firstFrame?.receivedAt).not.toBe(run?.startedAt.toISOString());
    await expect(
      inScope(() => onboardingAdvanceHandler({ to: "wrap" }, ctxFor(ownerId))),
    ).rejects.toSatisfy(refusal("conflict", "already_unlocked"));

    // A later batch changes nothing on the gate.
    const before = gate?.firstFrameAt?.getTime();
    const session2 = sessionUuid(hostPublicId, "sess-2");
    let cursor2: ChainCursor = GENESIS_CURSOR;
    const later: TachoEvent[] = [];
    for (const draft of [
      unsealed("agent_start", { session_start_source: "startup" }),
    ]) {
      const sealed = sealEvent(
        {
          ...draft,
          session_id: "sess-2",
          session_uuid: session2,
          root_session_uuid: session2,
        },
        cursor2,
      );
      cursor2 = sealed.next;
      later.push(sealed.event);
    }
    await inScope(() =>
      tachoEventsIngestHandler(
        {
          schema: "tacho.batch.v1",
          host_enrollment_id: hostPublicId,
          events: later,
        },
        { ...ctxFor(null), apiKeyId: hostApiKeyId },
      ),
    );
    const [after] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.onboardingState)
        .where(eq(schema.onboardingState.orgId, orgId)),
    );
    expect(after?.firstRunId).toBe(run?.publicId);
    expect(after?.firstFrameAt?.getTime()).toBe(before);
  });

  it("a provisional workspace refuses a context record until bind_main_repository closes the window", async () => {
    const record = {
      record_id: `rule-${tag}`,
      title: "No bare unwrap",
      body: "[rule]\nid = 'no-bare-unwrap'\n",
      kind: "rule" as const,
      force: "must" as const,
      statement: "Never unwrap a Result without handling the error.",
    };
    await expect(
      inScope(() => contextRecordPublishHandler(record, ctxFor(ownerId))),
    ).rejects.toSatisfy(refusal("conflict", "provisional"));

    const seen = new Map<
      string,
      {
        id: string;
        owner: string;
        name: string;
        fullName: string;
        htmlUrl: string;
        defaultBranch: string;
      }
    >([
      [
        "acme/widgets",
        {
          id: "1296269",
          owner: "acme",
          name: "widgets",
          fullName: "acme/widgets",
          htmlUrl: "https://github.com/acme/widgets",
          defaultBranch: "main",
        },
      ],
      [
        "acme/other",
        {
          id: "7777777",
          owner: "acme",
          name: "other",
          fullName: "acme/other",
          htmlUrl: "https://github.com/acme/other",
          defaultBranch: "main",
        },
      ],
    ]);
    const calls: string[] = [];
    const deps: MainRepositoryDeps = {
      repository: async (installationId, owner, name) => {
        calls.push(installationId);
        return seen.get(`${owner}/${name}`) ?? null;
      },
    };
    const bind = createMainRepositoryBindHandler(deps);

    for (const userId of [memberId, strangerId]) {
      await expect(
        inScope(() => bind({ owner: "acme", name: "widgets" }, ctxFor(userId))),
      ).rejects.toSatisfy(refusal("forbidden", "org_role_required"));
    }
    await expect(
      inScope(() => bind({ owner: "acme", name: "widgets" }, ctxFor(ownerId))),
    ).rejects.toSatisfy(refusal("conflict", "github_not_connected"));
    expect(calls).toEqual([]);

    // The installation the HMAC-verified callback attached to the workspace's connection.
    await withSystemDb((tx) =>
      tx.insert(schema.sourceConnections).values({
        orgId,
        workspaceId,
        connectorId: "github",
        displayName: "GitHub",
        authScheme: "github_app",
        deliveryMethod: "webhook",
        deliveryConfig: { installationId: "424242" },
        status: "pending_setup",
      }),
    );
    await expect(
      inScope(() => bind({ owner: "acme", name: "missing" }, ctxFor(ownerId))),
    ).rejects.toSatisfy(refusal("not_found", "repository_not_installed"));
    expect(calls).toEqual(["424242"]);

    // Three binds at once: two of acme/widgets and one of acme/other. One
    // repository wins; its calls answer the same binding, the other
    // repository's calls are main_repo_bound, and the workspace has one head.
    const raced = await Promise.allSettled(
      (["widgets", "widgets", "other"] as const).map((name) =>
        inScope(() => bind({ owner: "acme", name }, ctxFor(ownerId))),
      ),
    );
    const won = raced.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const lost = raced.flatMap((r) =>
      r.status === "rejected" ? [r.reason] : [],
    );
    const winner = won[0]?.fullName;
    const loser = winner === "acme/widgets" ? "other" : "widgets";
    expect(won).toHaveLength(winner === "acme/widgets" ? 2 : 1);
    expect(lost.every(refusal("conflict", "main_repo_bound"))).toBe(true);
    expect(new Set(won.map((b) => b.bindingId)).size).toBe(1);
    expect(new Set(won.map((b) => b.boundAt)).size).toBe(1);
    expect(won.filter((b) => b.provisionalClosed)).toHaveLength(1);
    const bound = won.find((b) => b.provisionalClosed);
    if (!bound) throw new Error("no bind closed the provisional window");
    expect(bound).toMatchObject({ defaultRef: "main" });
    expect(bound.bindingId).toMatch(/^rpb_[0-9a-f]+$/);
    const heads = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.repositoryBindingHeads)
        .where(eq(schema.repositoryBindingHeads.workspaceId, workspaceId)),
    );
    expect(heads).toHaveLength(1);
    expect(heads[0]?.providerRepositoryId).toBe(seen.get(bound.fullName)?.id);
    const bindings = await withSystemDb((tx) =>
      tx
        .select({ id: schema.repositoryBindings.id })
        .from(schema.repositoryBindings)
        .where(eq(schema.repositoryBindings.workspaceId, workspaceId)),
    );
    expect(bindings).toHaveLength(1);
    const [connection] = await withSystemDb((tx) =>
      tx
        .select({ status: schema.sourceConnections.status })
        .from(schema.sourceConnections)
        .where(eq(schema.sourceConnections.workspaceId, workspaceId)),
    );
    expect(connection?.status).toBe("connected");

    const again = await inScope(() =>
      bind(
        { owner: "acme", name: bound.fullName.slice("acme/".length) },
        ctxFor(ownerId),
      ),
    );
    expect(again).toMatchObject({
      bindingId: bound.bindingId,
      boundAt: bound.boundAt,
      provisionalClosed: false,
    });
    await expect(
      inScope(() => bind({ owner: "acme", name: loser }, ctxFor(ownerId))),
    ).rejects.toSatisfy(refusal("conflict", "main_repo_bound"));

    const state = await onboardingStateGetHandler({}, ctxFor(ownerId));
    expect(state.provisional?.mainRepoBoundAt).toBe(bound.boundAt);

    const published = await inScope(() =>
      contextRecordPublishHandler(record, ctxFor(ownerId)),
    );
    expect(published.published).toBe(true);
  });

  it("a live host keeps its agent key, a revoked host gives it up to a new token, and a retired agent's token is refused", async () => {
    const facts = (presented: string, hostname: string) =>
      tachoHostEnroll.input.parse({
        token: presented,
        hostname,
        osUser: "dev",
        platform: "darwin",
        devicePublicKey: `ed25519:${Buffer.alloc(32, 9).toString("base64")}`,
        harnesses: ["claude-code"],
      });
    const bare = { ...ctxFor(null), orgId: "", workspaceId: "" };
    const issue = async () =>
      (
        await inScope(() =>
          tachoEnrollmentTokenCreateHandler(
            { agentId: agentPublicId, ttlMinutes: 30 },
            ctxFor(ownerId),
          ),
        )
      ).token;

    await expect(
      tachoHostEnrollHandler(facts(await issue(), "mbp-six.local"), bare),
    ).rejects.toSatisfy(refusal("conflict", "agent_has_host"));

    await inScope(() =>
      tachoEnrollmentRevokeHandler(
        { hostEnrollmentId: hostPublicId, reason: "replaced" },
        ctxFor(ownerId),
      ),
    );
    const again = await tachoHostEnrollHandler(
      facts(await issue(), "mbp-seven.local"),
      bare,
    );
    expect(again).toMatchObject({ agentId: agentPublicId, agentKey });
    expect(again.hostEnrollmentId).not.toBe(hostPublicId);
    const hosts = await withSystemDb((tx) =>
      tx
        .select({
          publicId: schema.tachoHosts.publicId,
          status: schema.tachoHosts.status,
        })
        .from(schema.tachoHosts)
        .where(eq(schema.tachoHosts.orgId, orgId)),
    );
    expect(
      hosts.filter((h) => h.status !== "revoked").map((h) => h.publicId),
    ).toEqual([again.hostEnrollmentId]);
    const wait = await inScope(() =>
      onboardingFirstFrameGetHandler(
        { agentId: agentPublicId, waitMs: 0 },
        ctxFor(ownerId),
      ),
    );
    expect(wait.host?.hostEnrollmentId).toBe(again.hostEnrollmentId);

    const pending = await issue();
    await withSystemDb((tx) =>
      tx
        .update(schema.agents)
        .set({ deletedAt: new Date() })
        .where(eq(schema.agents.id, agentId)),
    );
    await expect(
      tachoHostEnrollHandler(facts(pending, "mbp-eight.local"), bare),
    ).rejects.toSatisfy(refusal("conflict", "agent_retired"));
  });

  it("an organization that predates the gate has no row: it reads as unlocked with no window and publishes", async () => {
    // The migration writes no row for an existing organization; this is
    // that shape: an organization and its workspace, nothing in
    // org.onboarding_state.
    const preOrgId = crypto.randomUUID();
    const preWorkspaceId = crypto.randomUUID();
    await withSystemDb((tx) =>
      tx.insert(schema.organizations).values({
        id: preOrgId,
        name: `G2967 pre ${tag}`,
        slug: `g2967-pre-${tag}`,
        namespace: `p${tag.slice(0, 5)}`,
        planType: "free",
        status: "active",
      }),
    );
    await withSystemDb((tx) =>
      tx.insert(schema.workspaces).values({
        id: preWorkspaceId,
        orgId: preOrgId,
        name: "Core",
        slug: "core",
        namespace: "core",
      }),
    );
    // The owner holds the Owner role there, so advance_onboarding passes
    // its role check and reaches the missing gate.
    await withSystemDb(async (tx) => {
      const [role] = await tx
        .insert(schema.roles)
        .values({ orgId: preOrgId, scopeKind: "org", name: "Owner" })
        .returning({ id: schema.roles.id });
      const [principal] = await tx
        .insert(schema.principals)
        .values({
          orgId: preOrgId,
          kind: "human",
          displayName: "Owner",
          parentUserId: ownerId,
        })
        .returning({ id: schema.principals.id });
      await tx.insert(schema.principalRoleAssignments).values({
        principalId: principal?.id ?? "",
        roleId: role?.id ?? "",
        orgId: preOrgId,
      });
    });
    const ctx = {
      ...ctxFor(ownerId),
      orgId: preOrgId,
      workspaceId: preWorkspaceId,
    };
    const inPreScope = <T>(fn: () => Promise<T>): Promise<T> =>
      runInTenantScope({ orgId: preOrgId, workspaceId: preWorkspaceId }, fn);
    try {
      expect(await onboardingStateGetHandler({}, ctx)).toEqual({
        step: "unlocked",
        workspace: null,
        firstFrameAt: null,
        firstRunId: null,
        provisional: null,
      });
      const published = await inPreScope(() =>
        contextRecordPublishHandler(
          {
            record_id: `rule-pre-${tag}`,
            title: "No bare unwrap",
            body: "[rule]\nid = 'no-bare-unwrap'\n",
            kind: "rule",
            force: "must",
            statement: "Never unwrap a Result without handling the error.",
          },
          ctx,
        ),
      );
      expect(published.published).toBe(true);
      await expect(
        inPreScope(() =>
          onboardingAdvanceHandler({ to: "run" }, { ...ctx, userId: ownerId }),
        ),
      ).rejects.toSatisfy(refusal("not_found", "gate_not_found"));
    } finally {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.contextRecords)
          .set({ activeVersionId: null })
          .where(eq(schema.contextRecords.orgId, preOrgId));
        await tx
          .delete(schema.contextRecordVersions)
          .where(eq(schema.contextRecordVersions.orgId, preOrgId));
        await tx
          .delete(schema.contextRecords)
          .where(eq(schema.contextRecords.orgId, preOrgId));
        await tx
          .delete(schema.principalRoleAssignments)
          .where(eq(schema.principalRoleAssignments.orgId, preOrgId));
        await tx
          .delete(schema.principals)
          .where(eq(schema.principals.orgId, preOrgId));
        await tx.delete(schema.roles).where(eq(schema.roles.orgId, preOrgId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.id, preWorkspaceId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, preOrgId));
      });
    }
  });
});
