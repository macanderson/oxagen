/**
 * Frame compaction — live-database proof (Mission Control spec §13.2, §13.3;
 * ADR-058; migration 20260915130000_run_recorder_replay.sql §7).
 *
 * `agent.compact_sealed_attempt_events()` is SECURITY DEFINER and granted to
 * the app role, so the hot window has to hold inside the function: it takes
 * no argument, and a call from the app role removes only the frames of a seal
 * older than thirteen months whose archive segment holds the same bytes. The
 * seal keeps event_count, merkle_root and archive_segment_ref.
 *
 * CI: rls-integration job (clean DB).
 * Local: DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *          pnpm --filter @oxagen/database exec vitest run \
 *          --config vitest.integration.config.ts integration/evidence-compaction.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const ORG = "00000000-0000-0000-0021-000000000001";
const WS = "00000000-0000-0000-0022-000000000001";
const RUN = "00000000-0000-0000-0023-000000000001";
const ATTEMPT_OLD = "00000000-0000-0000-0024-000000000001";
const ATTEMPT_YOUNG = "00000000-0000-0000-0024-000000000002";
const ATTEMPT_UNSEGMENTED = "00000000-0000-0000-0024-000000000003";
const SNAPSHOT_ID = "00000000-0000-0000-0025-000000000001";
const RETENTION_ID = "00000000-0000-0000-0026-000000000001";
const BINDING_ID = "00000000-0000-0000-0027-000000000001";
const CONNECTION_ID = "00000000-0000-0000-0028-000000000001";

const D = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;

/** Each attempt: its number, its one frame's run_seq, and when it sealed. */
const ATTEMPTS: ReadonlyArray<{
  id: string;
  number: number;
  runSeq: number;
  sealedAgo: string;
  segmented: boolean;
}> = [
  {
    id: ATTEMPT_OLD,
    number: 1,
    runSeq: 1,
    sealedAgo: "14 months",
    segmented: true,
  },
  {
    id: ATTEMPT_YOUNG,
    number: 2,
    runSeq: 2,
    sealedAgo: "1 month",
    segmented: true,
  },
  {
    id: ATTEMPT_UNSEGMENTED,
    number: 3,
    runSeq: 3,
    sealedAgo: "14 months",
    segmented: false,
  },
];

async function cleanup(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM agent.agent_run_attempt_seals WHERE org_id = ${ORG}`;
    await tx`DELETE FROM agent.agent_run_events WHERE org_id = ${ORG}`;
    await tx`DELETE FROM agent.agent_run_attempts WHERE org_id = ${ORG}`;
    await tx`DELETE FROM agent.agent_runs WHERE org_id = ${ORG}`;
    await tx`DELETE FROM ingestion.repository_bindings WHERE org_id = ${ORG}`;
    await tx`DELETE FROM evidence.retention_policy_versions WHERE org_id = ${ORG}`;
    await tx`DELETE FROM workspace.workspaces WHERE id = ${WS}`;
    await tx`DELETE FROM org.organizations WHERE id = ${ORG}`;
  });
}

beforeAll(async () => {
  await cleanup();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG}, 'cmp_test_org', 'Compaction Org', 'cmp-org', 'cmpo', 'free', 'active', 'business')
    `;
    await tx`
      INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
      VALUES (${WS}, 'cmp_test_ws', ${ORG}, 'Compaction WS', 'cmp-ws', 'cmpw')
    `;
    await tx`
      INSERT INTO evidence.retention_policy_versions
        (id, public_id, org_id, workspace_id, version, mode, ttl_days, policy_digest)
      VALUES (${RETENTION_ID}, 'cmp_test_rpv', ${ORG}, ${WS}, 1, 'content_exact', 90, ${D("a")})
    `;
    await tx`
      INSERT INTO ingestion.repository_bindings
        (id, public_id, org_id, workspace_id, connection_id, provider,
         provider_repository_id, provider_owner, provider_name, provider_full_name,
         configured_default_ref, observed_at, version)
      VALUES
        (${BINDING_ID}, 'cmp_test_rpb', ${ORG}, ${WS}, ${CONNECTION_ID}, 'github',
         '918273646', 'oxageninc', 'oxagen-platform', 'oxageninc/oxagen-platform',
         'main', now(), 1)
    `;
    await tx`
      INSERT INTO agent.agent_runs
        (id, public_id, org_id, workspace_id, surface, status, spec,
         spec_version, run_kind, spec_digest,
         initiating_principal_id, agent_principal_id, agent_id, agent_version_id,
         agent_version_checksum, authorization_snapshot_id,
         repository_binding_id, repository_provider, provider_repository_id,
         repository_connection_id, configured_default_ref, base_commit_sha, base_tree_sha,
         retention_policy_id, retention_policy_digest, max_attempts)
      VALUES
        (${RUN}, 'cmp_test_run', ${ORG}, ${WS}, 'repo-edit', 'pending', '{"version":2}'::jsonb,
         2, 'repo_edit', ${D("b")},
         gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         ${D("c")}, ${SNAPSHOT_ID},
         ${BINDING_ID}, 'github', '918273646',
         ${CONNECTION_ID}, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
         ${RETENTION_ID}, ${D("a")}, 3)
    `;
    for (const attempt of ATTEMPTS) {
      await tx`
        INSERT INTO agent.agent_run_attempts
          (id, public_id, org_id, workspace_id, run_id, attempt_number, worker_id,
           engine_name, engine_version, engine_build_digest)
        VALUES
          (${attempt.id}, ${`cmp_test_arat_${attempt.number}`}, ${ORG}, ${WS}, ${RUN},
           ${attempt.number}, 'worker-1', 'ts-engine', '2.0.0', ${D("a")})
      `;
      await tx`
        INSERT INTO agent.agent_run_events
          (org_id, workspace_id, run_id, event_record_version, attempt_id,
           run_seq, attempt_seq, event_schema_version, event_type, stage,
           payload_digest, event_digest, payload_inline, observed_at)
        VALUES (${ORG}, ${WS}, ${RUN}, 2, ${attempt.id},
                ${attempt.runSeq}, 1, 'agent-event/v1', 'admission.accepted', 'admission',
                ${D("d")}, ${D("e")}, '{"ok":true}'::jsonb, now())
      `;
      const graded = attempt.segmented;
      await tx`
        INSERT INTO agent.agent_run_attempt_seals
          (org_id, workspace_id, run_id, attempt_id, terminal_status, event_count,
           final_run_seq, final_attempt_seq, final_event_digest, event_stream_digest,
           sealer_kind, sealer_worker_id, sealed_at,
           replay_grade, merkle_root, archive_segment_ref, model_calls, tool_calls, turns)
        VALUES
          (${ORG}, ${WS}, ${RUN}, ${attempt.id}, 'completed', 1,
           ${attempt.runSeq}, 1, ${D("e")}, ${D("f")},
           'worker', 'worker-1', now() - ${attempt.sealedAgo}::interval,
           ${graded ? "inspect" : null}, ${graded ? D("9") : null},
           ${graded ? `evidence/${ORG}/${WS}/segments/${attempt.id}.ndjson.zst` : null},
           ${graded ? 0 : null}, ${graded ? 0 : null}, ${graded ? 0 : null})
      `;
    }
  });
});

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
});

async function framesOf(attemptId: string): Promise<number> {
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    return tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM agent.agent_run_events WHERE attempt_id = ${attemptId}
    `;
  });
  return Number(rows[0]?.n ?? 0);
}

describe("agent.compact_sealed_attempt_events()", () => {
  it("takes no cutoff: a caller cannot move the hot window (negative)", async () => {
    await expect(
      sql`SELECT agent.compact_sealed_attempt_events(now())`,
    ).rejects.toThrow(/does not exist/);
  });

  it("run as the app role, removes only frames sealed past thirteen months with a segment, and leaves the seal's figures", async () => {
    const role = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') AS exists
    `;
    await sql.begin(async (tx) => {
      if (role[0]?.exists) await tx.unsafe(`SET LOCAL ROLE oxagen_app`);
      await tx`SELECT agent.compact_sealed_attempt_events()`;
    });

    expect(await framesOf(ATTEMPT_OLD)).toBe(0);
    expect(await framesOf(ATTEMPT_YOUNG)).toBe(1);
    expect(await framesOf(ATTEMPT_UNSEGMENTED)).toBe(1);

    const seals = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      return tx<
        {
          attempt_id: string;
          event_count: number;
          merkle_root: string | null;
          archive_segment_ref: string | null;
        }[]
      >`
        SELECT attempt_id, event_count, merkle_root, archive_segment_ref
        FROM agent.agent_run_attempt_seals
        WHERE attempt_id = ${ATTEMPT_OLD}
      `;
    });
    expect(seals).toEqual([
      {
        attempt_id: ATTEMPT_OLD,
        event_count: 1,
        merkle_root: D("9"),
        archive_segment_ref: `evidence/${ORG}/${WS}/segments/${ATTEMPT_OLD}.ndjson.zst`,
      },
    ]);
  });
});
