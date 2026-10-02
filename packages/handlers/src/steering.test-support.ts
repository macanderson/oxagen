// steering.test-support.ts: published versions of S0's fixture repos, for the
// search_steering and read_steering handler tests.
import type { CheckedContext } from "@oxagen/oxagen";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import {
  fixtureRepo,
  organizationFixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  buildBundle,
  TreeReader,
  treeFromFiles,
  type BundleIdentity,
  type Delivery,
  type ReadFile,
} from "@oxagen/steering-bundle";
import type { SteeringScope } from "./steering.search";

export const SCOPE: SteeringScope = {
  orgId: "org_steering",
  workspaceId: "ws_steering",
  runId: null,
};

/** A checked MCP context, from a run when `runId` is given. */
export function steeringCtx(runId?: string): CheckedContext {
  return {
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    userId: null,
    apiKeyId: "key_1",
    requestId: "req_1",
    surface: "mcp",
    messageId: null,
    ...(runId === undefined ? {} : { runId }),
  };
}

const workspaceFiles = fixtureRepo();
const organizationFiles = organizationFixtureRepo();

async function publish(
  files: ReadonlyMap<string, string>,
  identity: BundleIdentity,
  version: number,
): Promise<Bundle> {
  const { bundle } = await buildBundle({
    identity,
    version,
    commit: "b5518188b20ddf02f905fadeaa50d9976abdcc90",
    published_at: "2026-09-24T10:00:30Z",
    reader: await TreeReader.open(treeFromFiles(files)),
    previous: null,
    // No server compiles here, so the tool manifest stays null.
    compiler: () => {
      throw new Error("the handler tests compile no tools");
    },
  });
  return bundle;
}

/** Version 21 of the workspace fixture and version 4 of the organization fixture. */
export async function fixtureDelivery(): Promise<Delivery> {
  return {
    workspace: await publish(
      workspaceFiles,
      {
        repository: "github.com/a-intel/oxagen-core-platform",
        scope: "workspace",
        organization: "a-intel",
        workspace: "core-platform",
      },
      21,
    ),
    organization: await publish(
      organizationFiles,
      { repository: "github.com/a-intel/oxagen", scope: "organization", organization: "a-intel" },
      4,
    ),
  };
}

/** Reads a fixture file by path, as the version store reads one by blob. */
export const readFixtureFile: ReadFile = (source, _bundle, file) => {
  const text = (source === "workspace" ? workspaceFiles : organizationFiles).get(file.path);
  return text === undefined
    ? Promise.reject(new Error(`${file.path} is not in the fixture`))
    : Promise.resolve(text);
};
