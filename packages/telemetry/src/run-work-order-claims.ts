/**
 * run-work-order-claims.ts — the work orders a wrapped run's frames name
 * (F13, #4638).
 *
 * A stage Oxagen launches for a work order carries the OTLP attribute
 * `oxagen.work_order.id` (@oxagen/work WORK_OTLP_ATTRIBUTES). The tacho
 * daemon re-keys every `oxagen.*` attribute that arrives over OTLP as
 * `client_claimed.oxagen.*` before it seals the frame, because anything that
 * can submit OTLP on the host could have set it. So the value is the
 * harness's word, and the spend rollup checks it against `work.orders` before
 * it stores it on `cost.run_totals`. This read only finds the claims.
 */
import { clickhouse } from "./clickhouse";
import { COST_FRAME_QUERY_SETTINGS } from "./cost-frames";

/** The OTLP attribute a work order's stage runs carry. */
export const WORK_ORDER_ATTR = "oxagen.work_order.id";

/** The same attribute after the daemon re-keyed it as a claim. */
export const CLAIMED_WORK_ORDER_ATTR = `client_claimed.${WORK_ORDER_ATTR}`;

/** The most distinct claims one read returns. A run names one work order. */
export const RUN_WORK_ORDER_CLAIM_LIMIT = 5;

/**
 * The distinct work order ids the run's frames claim, the earliest first, at
 * most {@link RUN_WORK_ORDER_CLAIM_LIMIT}. A frame that carries both spellings
 * counts as the unprefixed one. Empty when no frame names a work order.
 * Throws on a degraded store, so the rollup retries.
 */
export async function readRunWorkOrderClaims(args: {
  orgId: string;
  workspaceId: string;
  rootSessionUuid: string;
  /** The run's sessions, root first. */
  sessionUuids: readonly string[];
}): Promise<string[]> {
  const sessionUuids = args.sessionUuids.includes(args.rootSessionUuid)
    ? [...args.sessionUuids]
    : [args.rootSessionUuid, ...args.sessionUuids];
  const ch = clickhouse();
  const result = await ch.query({
    query: `
      SELECT claim
      FROM (
        SELECT
          if(attrs[{attr:String}] != '', attrs[{attr:String}], attrs[{claimedAttr:String}]) AS claim,
          min(ts)                                                                           AS first_at
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND root_session_uuid = {rootSessionUuid:UUID}
          AND session_uuid IN {sessionUuids:Array(UUID)}
          AND (attrs[{attr:String}] != '' OR attrs[{claimedAttr:String}] != '')
        GROUP BY claim
      )
      ORDER BY first_at, claim
      LIMIT {limit:UInt32}
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: args.rootSessionUuid,
      sessionUuids,
      attr: WORK_ORDER_ATTR,
      claimedAttr: CLAIMED_WORK_ORDER_ATTR,
      limit: RUN_WORK_ORDER_CLAIM_LIMIT,
    },
    format: "JSONEachRow",
    clickhouse_settings: COST_FRAME_QUERY_SETTINGS,
  });
  const rows = (await result.json()) as { claim: string }[];
  return rows.map((row) => row.claim.trim()).filter((claim) => claim !== "");
}
