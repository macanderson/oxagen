// The witness for #2597: a skill loaded inside a run produces a row the
// existing read-side join can find.
//
// `readSkillTokenCosts` has been in the tree since skill telemetry landed and
// has never returned a row in production. It joins `skill_loads` to
// `token_usage` on `execution_step_id`, and the sole producer of `skill_loads`
// wrote NULL into that column on every load — because `CapabilityContext`
// carried no execution identity to write. The query was correct; nothing ever
// fed it.
//
// So the assertion has to start from the far end. "The context can carry an
// id" would pass against a dead join, which is exactly how a dead join sat
// here unnoticed. This runs the REAL query against a REAL ClickHouse and
// asserts it returns the skill — and, as its control, that the same load
// recorded the old way (NULL) returns nothing. The control is the teeth: it is
// main's behaviour, and it must produce the silence we shipped.
//
// Live server rather than a mock, on the same convention as this package's
// other integration tests: a mocked client accepts any SQL without complaint,
// so it cannot tell a join that matches from one that cannot.
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

// Collection-time probe with a short abort, so the suite skips before any hook
// touches the network — the client's own transport timeout is ~30s and would
// burn the hook budget when nothing is listening.
async function clickhouseReachable(): Promise<boolean> {
  try {
    const url = new URL("/ping", process.env.CLICKHOUSE_URL);
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

const chUp = await clickhouseReachable();

beforeAll(async () => {
  if (!chUp) return;
  const { migrate } = await import("./migrate");
  await migrate();
}, 60_000);

describe.skipIf(!chUp)("skill_loads -> token_usage join (#2597)", () => {
  it("returns the skill when the load recorded its execution step", async () => {
    const { recordSkillLoad, readSkillTokenCosts } = await import(
      "./skill-telemetry"
    );
    const { insertTokenUsage } = await import("./clickhouse");

    // One workspace per run of this test, so repeated runs and a shared local
    // server cannot contaminate the assertion.
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const executionStepId = randomUUID();
    const recordedSkill = randomUUID();
    const unrecordedSkill = randomUUID();

    // The turn's model call, keyed by the step — this is what the platform
    // already writes today.
    await insertTokenUsage([
      {
        execution_step_id: executionStepId,
        org_id: orgId,
        workspace_id: workspaceId,
        model: "anthropic/claude-fable-5",
        provider: "anthropic",
        input_tokens: 1000,
        output_tokens: 100,
        cached_tokens: 0,
        cost_usd_micros: 42_000,
        duration_ms: 1234,
        surface: "runner",
        prompt_hash: "0".repeat(32),
        created_at: new Date().toISOString(),
      },
    ]);

    // The skill load, as the handler now records it inside a run.
    await recordSkillLoad({
      org_id: orgId,
      workspace_id: workspaceId,
      skill_id: recordedSkill,
      skill_slug: "recorded-skill",
      skill_version: 1,
      execution_step_id: executionStepId,
      surface: "runner",
      load_latency_ms: 5,
      created_at: new Date().toISOString(),
    });

    // The control: the SAME load as main records it. Not a hypothetical — this
    // is the literal value the handler hardcoded for every skill ever loaded.
    await recordSkillLoad({
      org_id: orgId,
      workspace_id: workspaceId,
      skill_id: unrecordedSkill,
      skill_slug: "unrecorded-skill",
      skill_version: 1,
      execution_step_id: null,
      surface: "runner",
      load_latency_ms: 5,
      created_at: new Date().toISOString(),
    });

    const costs = await readSkillTokenCosts({ orgId, workspaceId });
    const bySkill = new Map(costs.map((c) => [c.skill_id, c.cost_usd_micros]));

    // The join is alive: the run's cost is attributed to the skill it loaded.
    expect(
      bySkill.get(recordedSkill),
      "the join returned nothing for a skill loaded inside a run — " +
        "either the producer is not recording the step, or the two sides are " +
        "keyed differently",
    ).toBe(42_000);

    // ...and the pre-fix row is still invisible, which is what made the join
    // look correct-but-empty rather than broken.
    expect(bySkill.has(unrecordedSkill)).toBe(false);
  }, 30_000);

  it("attributes a step's cost once when a skill is loaded twice in it", async () => {
    // The de-duplication the query's DISTINCT exists for. Worth pinning here:
    // now that rows actually reach this join, a double-count would inflate
    // every skill's attributed cost and nothing else would notice.
    const { recordSkillLoad, readSkillTokenCosts } = await import(
      "./skill-telemetry"
    );
    const { insertTokenUsage } = await import("./clickhouse");

    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const executionStepId = randomUUID();
    const skillId = randomUUID();

    await insertTokenUsage([
      {
        execution_step_id: executionStepId,
        org_id: orgId,
        workspace_id: workspaceId,
        model: "anthropic/claude-fable-5",
        provider: "anthropic",
        input_tokens: 10,
        output_tokens: 1,
        cached_tokens: 0,
        cost_usd_micros: 7_000,
        duration_ms: 10,
        surface: "runner",
        prompt_hash: "0".repeat(32),
        created_at: new Date().toISOString(),
      },
    ]);

    for (let i = 0; i < 2; i++) {
      await recordSkillLoad({
        org_id: orgId,
        workspace_id: workspaceId,
        skill_id: skillId,
        skill_slug: "twice-loaded",
        skill_version: 1,
        execution_step_id: executionStepId,
        surface: "runner",
        load_latency_ms: 5,
        created_at: new Date().toISOString(),
      });
    }

    const costs = await readSkillTokenCosts({ orgId, workspaceId, skillId });
    expect(costs).toHaveLength(1);
    expect(costs[0]!.cost_usd_micros).toBe(7_000);
  }, 30_000);
});
