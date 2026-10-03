// The target a send reads, against a real Postgres (P1-04, ADR-198, ADR-251).
//
// readSendTarget reads three facts a send records, and these cases prove
// each one on the database's own rows:
//   - the mandate: the agent principal's active mandate whose validity started
//     last. An expired, revoked, not yet valid, or other agent's mandate is
//     never the one recorded, and an agent with none records none.
//   - the operator: the sender operates the agent when the agent principal's
//     parent user is the sender. A send from anyone else is refused.
//   - the runtime tier forecast: contained, observe, gateway, or harness, from
//     the runtime and the host the control plane observed.
//
// The pure tier precedence has its own case in helpers.test.ts. Each case here
// enrolls its own agent, runtime, and host, so one case's rows never decide
// another's answer.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it, so a green run means
// these cases ran. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { BUNDLE_FEATURE_WORK_ORDERS } from "@oxagen/recorder";
import { runInTenantScope } from "@oxagen/tenancy";
import { type BriefDraft, isWorkRecordError, workOrderKey } from "@oxagen/work/records";
import { and, eq, inArray } from "drizzle-orm";
import { type SendAction, sendOutput, sendWork } from "./actions";
import type { WorkActor } from "./actor";
import { type WorkScope, approveBrief, readWorkItem, recordSource, saveBrief } from "./store";
import { readSendTarget } from "./target";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The send target test needs DATABASE_URL on CI.");

const REPOSITORY = "aintel/platform";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A time `ms` from now. A negative `ms` is in the past. */
function fromNow(ms: number): Date {
  return new Date(Date.now() + ms);
}

const DRAFT: BriefDraft = {
  repository: REPOSITORY,
  criteria: [
    { text: "An expired invite shows the expiry message.", tag: "code", intent: "check", evidence: "invite test passes", provenance: "source" },
    { text: "The copy follows the house voice.", tag: "review", intent: "review", provenance: "person" },
  ],
};

describe.skipIf(!enabled)("send target against Postgres", { timeout: 30_000 }, () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const orgNamespace = `t${tag.slice(0, 5)}`;
  const workspaceNamespace = "core";
  /** The operator: the agent principals name him as their parent user. */
  const MARCUS = crypto.randomUUID();
  /** The reviewer: she approves the briefs and operates no agent. */
  const AMARA = crypto.randomUUID();
  let counter = 0;

  const inScope = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => runInTenantScope(scope, () => withTenantDb(fn));
  const targetOf = (agentPublicId: string, userId: string) => inScope((tx) => readSendTarget(tx, scope, agentPublicId, userId));

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values([
        { id: MARCUS, email: `marcus-${tag}@target.test`, status: "active" },
        { id: AMARA, email: `amara-${tag}@target.test`, status: "active" },
      ]);
      await tx.insert(schema.organizations).values({
        id: scope.orgId,
        name: `Target ${tag}`,
        slug: `target-${tag}`,
        namespace: orgNamespace,
        planType: "free",
        status: "active",
      });
      await tx.insert(schema.workspaces).values({
        id: scope.workspaceId,
        orgId: scope.orgId,
        name: "Core",
        slug: "core",
        namespace: workspaceNamespace,
      });
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const { orgId } = scope;
      await tx.delete(schema.workItemFacts).where(eq(schema.workItemFacts.orgId, orgId));
      await tx.delete(schema.workOrders).where(eq(schema.workOrders.orgId, orgId));
      await tx.delete(schema.workBriefs).where(eq(schema.workBriefs.orgId, orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, orgId));
      await tx.delete(schema.tachoControlCommands).where(eq(schema.tachoControlCommands.orgId, orgId));
      await tx.delete(schema.tachoHosts).where(eq(schema.tachoHosts.orgId, orgId));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
      await tx.delete(schema.mandates).where(eq(schema.mandates.orgId, orgId));
      await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
      await tx.delete(schema.runtimes).where(eq(schema.runtimes.orgId, orgId));
      await tx.delete(schema.principals).where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.id, scope.workspaceId));
      await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(inArray(schema.users.id, [MARCUS, AMARA]));
    });
    await closeDatabase();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  interface RigOptions {
    /** The agent principal's parent user. Marcus unless a case names another, or null for none. */
    operator?: string | null;
    /** False enrolls an agent with no IAM principal. */
    principal?: boolean;
    containmentRequired?: boolean;
    mode?: "observe" | "enforce";
    gatewayLastSeenAt?: Date | null;
  }

  interface Rig {
    agentPublicId: string;
    principalId: string | null;
  }

  /** A runtime, an agent on it, and the agent's host, which takes work orders. */
  async function rig(options: RigOptions = {}): Promise<Rig> {
    counter += 1;
    const n = counter;
    const slug = `bot-${tag.slice(0, 6)}-${n}`;
    const agentKey = `${orgNamespace}.${workspaceNamespace}.${slug}`;
    return withSystemDb(async (tx) => {
      const [runtime] = await tx
        .insert(schema.runtimes)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          name: `Laptop ${n}`,
          slug: `laptop-${tag}-${n}`,
          containmentRequired: options.containmentRequired ?? false,
          createdById: MARCUS,
        })
        .returning({ id: schema.runtimes.id });
      if (!runtime) throw new Error("fixture insert returned no row");

      let principalId: string | null = null;
      if (options.principal !== false) {
        const [principal] = await tx
          .insert(schema.principals)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            kind: "agent",
            displayName: `Bot ${n}`,
            status: "active",
            parentUserId: options.operator === undefined ? MARCUS : options.operator,
          })
          .returning({ id: schema.principals.id });
        if (!principal) throw new Error("fixture insert returned no row");
        principalId = principal.id;
      }

      const [agent] = await tx
        .insert(schema.agents)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          slug,
          name: `Bot ${n}`,
          agentType: "custom",
          status: "active",
          harness: "claude-code",
          principalId,
          runtimeId: runtime.id,
          createdById: MARCUS,
        })
        .returning({ id: schema.agents.id, publicId: schema.agents.publicId });
      if (!agent) throw new Error("fixture insert returned no row");

      const hostPublicId = `tch_${tag}t${n}`;
      const apiKeyId = crypto.randomUUID();
      await tx.insert(schema.apiKeys).values({
        id: apiKeyId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        keyPrefix: `oxk_${tag}t${n}`,
        keyHash: `hash-${tag}-t${n}`,
        name: `tacho host ${n}`,
        scope: { purpose: "tacho_host_v1", host_enrollment_id: hostPublicId },
        createdById: MARCUS,
      });
      await tx.insert(schema.tachoHosts).values({
        publicId: hostPublicId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        agentKey,
        agentId: agent.id,
        apiKeyId,
        runtimeId: runtime.id,
        hostname: `laptop-${n}`,
        hostnameDigest: "sha256:0",
        platform: "darwin",
        osUser: "marcus",
        osUserDigest: "sha256:0",
        devicePublicKey: `pk-${tag}-t${n}`,
        deviceKeyFingerprint: `fp-${tag}-t${n}`,
        enrollmentClaims: {},
        enrollmentSignature: "sig",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        status: "active",
        mode: options.mode ?? "enforce",
        lastSeenAt: new Date(),
        gatewayLastSeenAt: options.gatewayLastSeenAt ?? null,
        bundleFeatures: [BUNDLE_FEATURE_WORK_ORDERS],
      });
      return { agentPublicId: agent.publicId, principalId };
    });
  }

  interface MandateRow {
    principalId: string;
    validFrom: Date;
    validTo: Date;
    status?: "active" | "expired" | "revoked";
  }

  /** A mandate granted to an agent principal in this workspace. */
  async function mandate(row: MandateRow): Promise<string> {
    const [inserted] = await withSystemDb((tx) =>
      tx
        .insert(schema.mandates)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          agentPrincipalId: row.principalId,
          grantedBy: MARCUS,
          roleAtGrant: "Owner",
          impacts: ["moves_money"],
          limits: {},
          tools: ["*"],
          purpose: "send target test",
          validFrom: row.validFrom,
          validTo: row.validTo,
          status: row.status ?? "active",
        })
        .returning({ id: schema.mandates.id }),
    );
    if (!inserted) throw new Error("fixture insert returned no row");
    return inserted.id;
  }

  /** A rig's principal, which every case that grants a mandate needs. */
  function principalOf(r: Rig): string {
    if (r.principalId === null) throw new Error("The rig has no agent principal.");
    return r.principalId;
  }

  /** A work item with a brief Amara saved and approved, so it is ready to send. */
  async function readyItem(): Promise<{ itemId: string; publicId: string }> {
    counter += 1;
    const n = counter;
    const itemId = await inScope(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          number: `TGT-${tag}-${n}`,
          subject: "Fix invites",
          origin: "provider",
          providerId: `issue:node:${tag}t${n}`,
          sourceUrl: `https://github.com/${REPOSITORY}/issues/${n}`,
        })
        .returning({ id: schema.workItems.id });
      if (!row) throw new Error("fixture insert returned no row");
      return row.id;
    });
    const collected = await inScope((tx) =>
      recordSource(tx, scope, {
        itemId,
        material: { subject: "Fix invites", description: "The link 500s.", labels: ["bug"] },
        source: "provider",
        actor: "github",
        occurredAt: new Date().toISOString(),
        dedupeKey: `delivery-${n}`,
      }),
    );
    const saved = await inScope((tx) =>
      saveBrief(tx, scope, { itemId, expectedVersion: collected.version, itemRevision: 1, draft: DRAFT, actor: AMARA, source: "person", actorUserId: AMARA }),
    );
    const approved = await inScope((tx) =>
      approveBrief(tx, scope, {
        itemId,
        expectedVersion: saved.version,
        itemRevision: 1,
        briefRevision: 1,
        briefDigest: saved.projection.latestBrief!.digest,
        actorUserId: AMARA,
      }),
    );
    expect(approved.projection.state).toBe("ready");
    return { itemId, publicId: approved.publicId };
  }

  /** The send a person's page submits for the item as it reads now. */
  async function sendAction(item: { itemId: string; publicId: string }, r: Rig): Promise<SendAction> {
    const record = await inScope((tx) => readWorkItem(tx, scope, item.itemId));
    const approved = record.projection.approvedBrief!;
    return {
      item_id: item.publicId,
      version: record.version,
      item_revision: record.projection.revision,
      brief_revision: approved.revision,
      brief_digest: approved.digest,
      agent_id: r.agentPublicId,
      key: workOrderKey(item.publicId, approved.revision, record.projection.nextSend),
    };
  }

  // -------------------------------------------------------------------------
  // The mandate at send
  // -------------------------------------------------------------------------

  it("records the agent's active mandate whose validity started last", async () => {
    const r = await rig();
    const other = await rig();
    const principalId = principalOf(r);
    await mandate({ principalId, validFrom: fromNow(-2 * DAY), validTo: fromNow(30 * DAY) });
    const latest = await mandate({ principalId, validFrom: fromNow(-DAY), validTo: fromNow(30 * DAY) });
    // Each mandate below started after the latest one, so the answer is only
    // right when the read leaves every one of them out.
    await mandate({ principalId, validFrom: fromNow(-2 * HOUR), validTo: fromNow(-HOUR) });
    await mandate({ principalId, validFrom: fromNow(-HOUR), validTo: fromNow(30 * DAY), status: "expired" });
    await mandate({ principalId, validFrom: fromNow(-HOUR / 2), validTo: fromNow(30 * DAY), status: "revoked" });
    await mandate({ principalId, validFrom: fromNow(DAY), validTo: fromNow(30 * DAY) });
    await mandate({ principalId: principalOf(other), validFrom: fromNow(-HOUR / 4), validTo: fromNow(30 * DAY) });

    expect((await targetOf(r.agentPublicId, MARCUS)).mandateId).toBe(latest);
  });

  it("records no mandate when the agent has no active one, or no principal", async () => {
    const r = await rig();
    await mandate({ principalId: principalOf(r), validFrom: fromNow(-2 * DAY), validTo: fromNow(-DAY) });
    expect((await targetOf(r.agentPublicId, MARCUS)).mandateId).toBeNull();

    const bare = await rig({ principal: false });
    expect(await targetOf(bare.agentPublicId, MARCUS)).toMatchObject({ agentPrincipalId: null, mandateId: null, operatesAgent: false });
  });

  // -------------------------------------------------------------------------
  // The operator
  // -------------------------------------------------------------------------

  it("says the sender operates the agent only when the agent principal's parent user is the sender", async () => {
    const r = await rig();
    expect((await targetOf(r.agentPublicId, MARCUS)).operatesAgent).toBe(true);
    expect((await targetOf(r.agentPublicId, AMARA)).operatesAgent).toBe(false);

    const amaras = await rig({ operator: AMARA });
    expect((await targetOf(amaras.agentPublicId, AMARA)).operatesAgent).toBe(true);
    expect((await targetOf(amaras.agentPublicId, MARCUS)).operatesAgent).toBe(false);

    const unowned = await rig({ operator: null });
    expect((await targetOf(unowned.agentPublicId, MARCUS)).operatesAgent).toBe(false);
  });

  it("refuses a send from a person who does not operate the agent, and records the mandate on the operator's send", async () => {
    const r = await rig();
    const granted = await mandate({ principalId: principalOf(r), validFrom: fromNow(-DAY), validTo: fromNow(30 * DAY) });
    const item = await readyItem();
    const input = await sendAction(item, r);

    const amara: WorkActor = { userId: AMARA, role: "Owner" };
    const error = await inScope((tx) => sendWork(tx, scope, amara, input, null)).catch((caught: unknown) => caught);
    expect(isWorkRecordError(error, "forbidden")).toBe(true);
    expect((error as Error).message).toContain("You do not operate this agent.");
    const none = await withSystemDb((tx) =>
      tx
        .select({ id: schema.workOrders.id })
        .from(schema.workOrders)
        .where(and(eq(schema.workOrders.orgId, scope.orgId), eq(schema.workOrders.idempotencyKey, input.key))),
    );
    expect(none).toEqual([]);

    const marcus: WorkActor = { userId: MARCUS, role: "Owner" };
    const sent = await inScope((tx) => sendWork(tx, scope, marcus, input, null));
    expect(sendOutput(sent).target).toMatchObject({ agent_id: r.agentPublicId, mandate_id: granted, runtime_tier: "harness" });
    const [order] = await withSystemDb((tx) =>
      tx
        .select({ mandateId: schema.workOrders.mandateId, operatorId: schema.workOrders.operatorId, runtimeTier: schema.workOrders.runtimeTier })
        .from(schema.workOrders)
        .where(eq(schema.workOrders.id, sent.write.orderId)),
    );
    expect(order).toEqual({ mandateId: granted, operatorId: MARCUS, runtimeTier: "harness" });
  });

  // -------------------------------------------------------------------------
  // The runtime tier forecast
  // -------------------------------------------------------------------------

  it("forecasts the runtime tier from the runtime and the host", async () => {
    const seen = fromNow(-HOUR);
    const contained = await rig({ containmentRequired: true, mode: "observe", gatewayLastSeenAt: seen });
    const observe = await rig({ mode: "observe", gatewayLastSeenAt: seen });
    const gateway = await rig({ mode: "enforce", gatewayLastSeenAt: seen });
    const harness = await rig({ mode: "enforce", gatewayLastSeenAt: null });

    expect((await targetOf(contained.agentPublicId, MARCUS)).runtimeTier).toBe("contained");
    expect((await targetOf(observe.agentPublicId, MARCUS)).runtimeTier).toBe("observe");
    expect((await targetOf(gateway.agentPublicId, MARCUS)).runtimeTier).toBe("gateway");
    expect((await targetOf(harness.agentPublicId, MARCUS)).runtimeTier).toBe("harness");
  });
});
