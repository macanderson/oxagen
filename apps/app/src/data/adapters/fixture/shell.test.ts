// The fixture shell (the ShellReadPort half of the fixture source): built from
// the seed, internally consistent, fenced to the fixture operator, and walking
// the engine and notification states behind its switches.
import { describe, expect, it } from "vitest";
import { FIXTURE_TENANT } from "@/data/fixture-tenant";
import { ORG_ONLY_WORKSPACE_ID, type Scope } from "@/data/scope";
import { FIXTURE_USER } from "@/server/fixture-session";
import { seed } from "./seed";
import { testFixtureShell, testFixtureSource } from "./testing";

const ORG: Scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
const FOREIGN: Scope = {
  orgId: "7f1c2a9e-0000-4000-8000-000000000000",
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
const ME = FIXTURE_USER.id;

const reads = (
  port: ReturnType<typeof testFixtureShell>,
  scope: Scope,
  user: string,
) => ({
  context: () => port.context(scope, user),
  navCounts: () => port.navCounts(scope),
  notifications: () => port.notifications(scope, user),
  assistantEngine: () => port.assistantEngine(scope),
  recentRuns: () => port.recentRuns(scope),
  account: () => port.account(scope, user),
  people: () => port.people(scope),
});

describe("fixture shell", () => {
  const port = testFixtureShell();

  it("answers every read for the demo organization", async () => {
    for (const [name, read] of Object.entries(reads(port, ORG, ME)))
      expect((await read()).ok, name).toBe(true);
  });

  it("is internally consistent: counts, runs and the viewer point at real records", async () => {
    const [context, counts, runs, account] = await Promise.all([
      port.context(ORG, ME),
      port.navCounts(ORG),
      port.recentRuns(ORG),
      port.account(ORG, ME),
    ]);
    if (!context.ok || !counts.ok || !runs.ok || !account.ok)
      throw new Error("fixture read failed");
    const slugs = new Set(context.value.workspaces.map((w) => w.slug));
    expect([...slugs].sort()).toEqual(
      seed.workspaces.map((w) => w.slug).sort(),
    );
    for (const slug of Object.keys(counts.value)) expect(slugs).toContain(slug);
    const runIds = new Set(seed.runs.map((r) => r.id));
    for (const run of runs.value) {
      expect(slugs).toContain(run.workspace);
      expect(runIds).toContain(run.id);
    }
    expect(context.value.orgs.map((o) => o.slug)).toContain(
      context.value.org.slug,
    );
    expect(context.value.org.name).toBe(seed.organization.name);
    expect(account.value.profile.email).toBe(context.value.viewer.email);
  });

  it("counts what each workspace's pages list, never an invented number", async () => {
    const counts = await port.navCounts(ORG);
    if (!counts.ok) throw new Error("fixture read failed");
    for (const w of seed.workspaces) {
      expect(counts.value[w.slug]?.pendingApprovals).toBe(
        seed.approvals.filter(
          (a) => a.workspaceSlug === w.slug && a.status === "pending",
        ).length,
      );
      expect(counts.value[w.slug]?.agents).toBe(w.agentCount);
    }
  });

  it("offers the newest runs first in the command menu", async () => {
    const runs = await port.recentRuns(ORG);
    if (!runs.ok) throw new Error("fixture read failed");
    const started = runs.value.map(
      (r) => seed.runs.find((x) => x.id === r.id)?.startedAt ?? "",
    );
    expect(started).toEqual([...started].sort().reverse());
    expect(runs.value.length).toBeGreaterThan(0);
  });

  it("has no organization for another tenant or another user (404, never a hint)", async () => {
    for (const [name, read] of Object.entries(reads(port, FOREIGN, ME)))
      expect(await read(), name).toMatchObject({
        reason: "error",
        code: "organization_not_found",
        status: 404,
      });
    expect(await port.context(ORG, "usr_someoneelse")).toMatchObject({
      code: "organization_not_found",
      status: 404,
    });
    expect(await port.notifications(ORG, "")).toMatchObject({ status: 404 });
    expect(await port.account(ORG, "usr_someoneelse")).toMatchObject({
      code: "account_not_found",
      status: 404,
    });
  });

  it("walks the engine and notification states behind the switches", async () => {
    const down = testFixtureShell({ engine: "down", notifications: "empty" });
    expect(await down.assistantEngine(ORG)).toMatchObject({
      ok: true,
      value: { status: "down", httpStatus: 503 },
    });
    expect(await down.notifications(ORG, ME)).toEqual({
      ok: true,
      value: { items: [] },
    });
    expect(
      await testFixtureShell({
        engine: "up",
        notifications: "error",
      }).notifications(ORG, ME),
    ).toMatchObject({
      reason: "error",
      code: "notification_store_unavailable",
      status: 503,
    });
    expect(
      await testFixtureShell({
        engine: "up",
        notifications: "not_backed",
      }).notifications(ORG, ME),
    ).toMatchObject({ reason: "not_backed" });
  });

  it("puts the engine down on mc_state assistant:down too (W9)", async () => {
    expect(
      await testFixtureSource({
        state: "assistant:down",
      }).shell.assistantEngine(ORG),
    ).toMatchObject({ ok: true, value: { status: "down" } });
  });

  it("ignores the switches when they are not honoured (negative)", async () => {
    const off = testFixtureSource({
      state: "shell:error,assistant:down",
      shell: { engine: "down", notifications: "error" },
      honourSwitches: false,
    }).shell;
    expect(await off.assistantEngine(ORG)).toMatchObject({
      value: { status: "up" },
    });
    expect((await off.notifications(ORG, ME)).ok).toBe(true);
  });
});
