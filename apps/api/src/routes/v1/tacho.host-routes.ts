import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import { tachoBundleGetRoute } from "./tacho.bundle.get";
import { tachoCommandFetchRoute } from "./tacho.command.fetch";
import { tachoContainedLaunchRegisterRoute } from "./tacho.contained_launch.register";
import { tachoEventsIngestRoute } from "./tacho.events.ingest";
import { tachoGithubTokenIssueRoute } from "./tacho.github_token.issue";
import { tachoMemoriesIngestRoute } from "./tacho.memories.ingest";
import { tachoMemoriesRecallRoute } from "./tacho.memories.recall";
import { tachoMemoryUsesRecordRoute } from "./tacho.memories.uses.record";
import { tachoSessionHeadsListRoute } from "./tacho.session_heads.list";
import { workCriterionHostClaimRoute } from "./work.criterion.claim.host";
import { workOrderClaimRoute } from "./work.order.claim";
import { workOrderRejectRoute } from "./work.order.reject";

/**
 * Mount the routes an enrolled Tacho host calls, largest body limit first.
 *
 * Each of these routes registers its API-key check and its `bodyLimit` on
 * `*`. `router.route("/", sub)` turns that `*` into `/*` on the shared
 * router, so a route's body limit also runs on every route mounted after it.
 * Mounted in the old order (events, bundle, GitHub credential, contained
 * launch, commands), the command poll ran behind the two 4 KiB limits and
 * refused any poll over 4 KiB, although its own limit is 256 KiB. A poll
 * carries up to 100 acknowledgements with 512-character details.
 *
 * Largest first means every route runs only behind limits at least as large
 * as its own, so its own limit is the one that holds. A new route goes in by
 * the size of its limit. tacho.host-routes.test.ts sends each route a body
 * at its own limit and one a byte over it.
 */
export function mountTachoHostRoutes(router: Hono<AppEnv>): void {
  router.route("/", tachoEventsIngestRoute); // TACHO_MAX_REQUEST_BYTES, 4 MiB
  router.route("/", tachoMemoryUsesRecordRoute); // 1 MiB
  router.route("/", tachoMemoriesRecallRoute); // 384 KiB
  router.route("/", tachoCommandFetchRoute); // 256 KiB
  router.route("/", tachoSessionHeadsListRoute); // 128 KiB
  router.route("/", tachoBundleGetRoute); // 64 KiB
  router.route("/", tachoMemoriesIngestRoute); // 32 KiB
  router.route("/", workOrderClaimRoute); // 16 KiB
  router.route("/", workOrderRejectRoute); // 16 KiB
  router.route("/", workCriterionHostClaimRoute); // 16 KiB
  router.route("/", tachoGithubTokenIssueRoute); // 4 KiB
  router.route("/", tachoContainedLaunchRegisterRoute); // 4 KiB
}
