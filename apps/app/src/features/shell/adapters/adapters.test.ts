import { describe, expect, it } from "vitest";
import { FIXTURE_USER } from "@/server/fixture-session";
import { DEFAULT_SWITCHES } from "../fixture-switches";
import type { ShellQuery } from "../port";
import { fixtureShell } from "./fixture";
import { liveShell } from "./live";

const acme: ShellQuery = { org: "acme", ws: null, userId: FIXTURE_USER.id };
const reads = [
  "context",
  "navCounts",
  "notifications",
  "assistantEngine",
  "recentRuns",
  "account",
] as const;

describe("fixture shell adapter", () => {
  const port = fixtureShell(DEFAULT_SWITCHES);

  it("answers every read for the demo organization", async () => {
    for (const read of reads)
      expect((await port[read](acme)).ok, read).toBe(true);
  });

  it("is internally consistent: counts, runs and the viewer point at real records", async () => {
    const context = await port.context(acme);
    const counts = await port.navCounts(acme);
    const runs = await port.recentRuns(acme);
    const account = await port.account(acme);
    if (!context.ok || !counts.ok || !runs.ok || !account.ok)
      throw new Error("fixture read failed");
    const slugs = new Set(context.value.workspaces.map((w) => w.slug));
    for (const slug of Object.keys(counts.value)) expect(slugs).toContain(slug);
    for (const run of runs.value) expect(slugs).toContain(run.workspace);
    expect(context.value.orgs.map((o) => o.slug)).toContain(
      context.value.org.slug,
    );
    expect(account.value.profile.email).toBe(context.value.viewer.email);
  });

  it("has no organization for another slug or another user (404, never a hint)", async () => {
    for (const q of [
      { ...acme, org: "globex" },
      { ...acme, userId: "usr_someoneelse" },
      { ...acme, userId: "" },
    ])
      for (const read of reads.filter((r) => r !== "account"))
        expect(await port[read](q), `${read} ${JSON.stringify(q)}`).toEqual({
          ok: false,
          reason: "error",
          code: "organization_not_found",
          status: 404,
        });
    expect(
      await port.account({ ...acme, userId: "usr_someoneelse" }),
    ).toMatchObject({ status: 404 });
  });

  it("walks the engine and notification states behind the switches", async () => {
    const down = fixtureShell({ engine: "down", notifications: "empty" });
    expect(await down.assistantEngine(acme)).toMatchObject({
      ok: true,
      value: { status: "down", httpStatus: 503 },
    });
    expect(await down.notifications(acme)).toEqual({
      ok: true,
      value: { items: [] },
    });
    expect(
      await fixtureShell({
        engine: "up",
        notifications: "error",
      }).notifications(acme),
    ).toMatchObject({
      reason: "error",
      status: 503,
    });
    expect(
      await fixtureShell({
        engine: "up",
        notifications: "not_backed",
      }).notifications(acme),
    ).toMatchObject({
      reason: "not_backed",
    });
  });
});

describe("live shell adapter", () => {
  it("says every read is not wired yet instead of inventing data", async () => {
    for (const read of reads) {
      const result = await liveShell[read](acme);
      expect(result).toMatchObject({ ok: false, reason: "error", status: 501 });
      expect(
        result.ok ? "" : result.reason === "error" ? result.code : "",
      ).toMatch(/^shell_.+_not_wired$/);
    }
  });
});
