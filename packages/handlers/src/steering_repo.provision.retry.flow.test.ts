// steering_repo.provision.retry.flow.test.ts: a failed steering repo setup
// reaches ready through retry_steering_repo_provision (#4750).
//
// The provisioning steps run against the in-memory GitHub fake. The bind write
// fails once, which leaves the workspace failed at bind_repository. The retry
// handler's send runs the job again, as the provision event does in
// production, and the job finishes over the repository the first run made.
import * as gh from "@oxagen/github/provision";
import { FakeGithub } from "@oxagen/github/provision/testing";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import { OXAGEN_STEERING_APP } from "@oxagen/oxagen/steering-repo";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/capability-role-guard", () => ({
  assertContractRole: vi.fn(async () => "Owner"),
}));
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  provisionSteeringRepo,
  type ProvisionDeps,
  type SteeringConnection,
  type SteeringRepoScope,
  type SteeringRepoState,
} from "./steering_repo.provision";
import { createRetrySteeringRepoProvisionHandler } from "./steering_repo.provision.retry";
import { TEST_CTX } from "./test-utils/fixtures";

const NOW = new Date("2026-09-29T00:00:00.000Z");
const ORG = "acme";
const APP: gh.SteeringApp = {
  symbol: OXAGEN_STEERING_APP,
  id: 9001,
  slug: "oxagen-steering-test",
};
const WS: SteeringRepoScope = {
  kind: "workspace",
  orgId: "org_1",
  workspaceId: "ws_1",
};

/** One workspace's stored state and connection, over one GitHub fake. */
class World {
  readonly hub = new FakeGithub({ org: ORG, app: APP });
  state: SteeringRepoState | null = null;
  connection: SteeringConnection | null = null;
  /** How many more bind writes fail. */
  bindFaults = 1;
  binds = 0;

  deps(): ProvisionDeps {
    return {
      now: () => NOW,
      load: async () => ({
        target: {
          org_slug: ORG,
          workspace: { slug: "support", name: "Support" },
        },
        state: structuredClone(this.state),
        connection: structuredClone(this.connection),
      }),
      saveState: async (_scope, state) => {
        this.state = structuredClone(state);
      },
      saveConnection: async (_scope, connection) => {
        this.connection = structuredClone(connection);
      },
      github: () => ({
        app: APP,
        installation: async () => this.hub.appRest(),
        user: async () => this.hub.userRest(),
      }),
      gitlab: () => ({ groups: async () => [], group: async () => null }),
      bind: async () => {
        if (this.bindFaults > 0) {
          this.bindFaults -= 1;
          throw new Error("the binding write failed");
        }
        this.binds += 1;
        return "rpb_test";
      },
      notifyReauthorize: async () => {},
      steeringHook: () => {
        throw new Error("a GitHub steering repo asks for no hook");
      },
    };
  }

  repositories(): string[] {
    const snap = this.hub.snapshot() as {
      repositories: Record<string, unknown>;
    };
    return Object.keys(snap.repositories);
  }
}

describe("a retry after a failed step", () => {
  it("takes a workspace that failed at bind_repository to ready over the same repository", async () => {
    const w = new World();
    await expect(provisionSteeringRepo(w.deps(), WS)).rejects.toThrow(
      "the binding write failed",
    );
    expect(w.state).toMatchObject({
      status: "failed",
      failed_step: "bind_repository",
      error: { code: "step_failed" },
    });
    expect(w.repositories()).toEqual(["oxagen-support"]);

    const sent: string[] = [];
    const handler = createRetrySteeringRepoProvisionHandler({
      loadState: async () => structuredClone(w.state),
      saveState: async (_scope, state) => {
        w.state = structuredClone(state);
      },
      saveConnection: async () => {},
      resetConnection: async () => null,
      send: async (_data, eventId) => {
        sent.push(eventId);
        await provisionSteeringRepo(w.deps(), WS);
      },
      now: () => NOW,
    });

    // The handler answers before the job runs in production, so it reports
    // provisioning even though this send ran the job to the end.
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
    ).resolves.toEqual({ status: "provisioning" });
    expect(sent).toHaveLength(1);
    expect(w.state).toMatchObject({
      status: "ready",
      failed_step: null,
      error: null,
    });
    expect(w.repositories()).toEqual(["oxagen-support"]);
    expect(w.binds).toBe(1);
  });
});
