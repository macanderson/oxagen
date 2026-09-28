import { NonRetriableError } from "@oxagen/functions";

import { createFunction } from "../create-function";
import {
  steeringRepoHealthRunner,
  type SteeringRepoHealthTrigger,
} from "../lib/steering-repo-health-runner";

/**
 * The trigger a health request carries when its event names none. Every
 * sender sets one, so this reads an older or hand-sent event as the sweep.
 */
const NO_TRIGGER: SteeringRepoHealthTrigger = {
  reason: "sweep",
  actor: null,
  at: null,
  settings: [],
  pull_request: null,
};

/**
 * The 10-minute health sweep of every ready steering repo (lane S2, #4560).
 *
 * A webhook asks for a health read as soon as a setting changes, but a
 * delivery can be lost, and GitLab sends no event for most setting changes.
 * The sweep asks for one read per ready steering repo, so drift is found
 * within 10 minutes whether or not an event arrived. The reads run in
 * `steering-repo/health-check`, one repo at a time.
 */
export const [steeringRepoSweep] = createFunction(
  { id: "steering-repo/health-sweep", retries: 1, concurrency: { limit: 1 } },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    const requests = await step.run("list-steering-repos", () =>
      steeringRepoHealthRunner().sweepRequests(),
    );
    if (requests.length === 0) return { requested: 0 };
    await step.sendEvent(
      "request-health-checks",
      requests.map((r) => ({
        name: "steering-repo/health.requested",
        data: { ...r.data },
      })),
    );
    return { requested: requests.length };
  },
);

/**
 * Read one steering repo's health and act on it (lane S2, #4560).
 *
 * The GitHub and GitLab webhook routes and the sweep send
 * `steering-repo/health.requested`. The runner reads the repo's settings,
 * stores the state, fails the health check on every open steering PR while
 * the repo is unhealthy, and puts the checks back when it recovers. One read
 * runs at a time per repo, keyed `<orgId>:<workspaceId or "org">`, so two
 * events for one repo cannot post over each other. A rate limit throws, and
 * Inngest retries the read.
 */
export const [steeringRepoHealthCheck] = createFunction(
  {
    id: "steering-repo/health-check",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.key" },
  },
  { event: "steering-repo/health.requested" },
  async ({ event, step }) => {
    const data = event.data as {
      orgId?: unknown;
      workspaceId?: unknown;
      trigger?: SteeringRepoHealthTrigger | null;
    };
    if (typeof data.orgId !== "string" || data.orgId === "")
      throw new NonRetriableError(
        "steering-repo/health-check: the event names no organization, so there is no steering repo to read.",
      );
    const scope = {
      orgId: data.orgId,
      workspaceId: typeof data.workspaceId === "string" ? data.workspaceId : null,
    };
    const trigger = data.trigger ?? NO_TRIGGER;
    const result = await step.run("check", () =>
      steeringRepoHealthRunner().check(scope, trigger),
    );
    return { health: result?.health ?? null };
  },
);
