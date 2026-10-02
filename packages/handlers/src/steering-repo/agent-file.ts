// steering-repo/agent-file.ts: the agent file Oxagen proposes when a host
// enrolls (#5149, ADR-265).
//
// The MCP gateway serves a workspace's published tools only to a run it can
// match to an agent file, `agents/<name>.toml`, by the run's runtime. Nothing
// else in Oxagen writes one for a new workspace. So when
// `create_tacho_enrollment` binds a host to a runtime, Oxagen opens a steering
// PR that adds the file:
//
//   name      the runtime's slug (agentNameForRuntime)
//   operator  the enrolling member's public user id
//   runtime   the runtime's slug, which the gateway matches runs on
//   harness   the one harness the host reports, or the first it lists
//
// The PR carries an `agent_file` proposal row, written by the shared opener,
// so a person merges it from Oxagen through the merge queue.
//
// It opens nothing, and says why, when:
//   - the runtime's slug is not a valid agent name
//   - the host reports no harness an agent file can name
//   - an `agent_file` proposal on `agents/<name>` is open or merged, so
//     enrolling the same runtime again opens no second PR
//   - the production branch already holds `agents/<name>.toml`, or another
//     agent file that names this runtime: a second file on one runtime would
//     stop the gateway from matching either without a session's harness
//
// The file carries no secret. agent/v1 refuses `toolbelt`, `budget`, and
// `environment` (decided 2026-09-26), and this file sets none of them.
import { isHandlerError } from "@oxagen/oxagen";
import {
  agentHarnessSchema,
  type AgentHarness,
} from "@oxagen/oxagen/contracts/agent.list";
import {
  agentFileText,
  agentNameForRuntime,
  agentSchema,
} from "@oxagen/oxagen/steering-repo/agent";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import {
  AGENTS_DIR,
  agentFilePath,
} from "@oxagen/oxagen/steering-repo/paths";
import { TACHO_HARNESS_LABELS, type TachoHarness } from "@oxagen/recorder";
import type {
  SteeringHost,
  SteeringRepository,
} from "../context.steering.github";
import type { SteeringStore } from "../context.steering.store";
import { logger } from "../logger";
import {
  steeringFilesRefusal,
  type SteeringPullRequestKind,
  type ToolsPullRequestOpener,
} from "../tools.pr.open";
import { personAuthor } from "./pr-proposal";

/** The agent file PR: one `agents/<name>.toml` on an `agents/` branch. */
export const AGENT_FILE_PULL_REQUEST: SteeringPullRequestKind = {
  reasonPrefix: "agent_file",
  noun: "agent file steering PR",
  refusal: (args) =>
    args.branch.startsWith(`${AGENTS_DIR}/`)
      ? steeringFilesRefusal(args)
      : {
          reason: "branch_prefix",
          message: `${args.branch} does not start with ${AGENTS_DIR}/. An agent file steering PR changes only ${AGENTS_DIR}/.`,
        },
  proposalKind: "agent_file",
};

/** What the agent file PR reads and opens through. Tests pass fakes. */
export interface AgentFileDeps {
  opener: ToolsPullRequestOpener;
  host: () => Pick<SteeringHost, "resolveRepository" | "readFile" | "listFiles">;
  proposals: Pick<SteeringStore, "listProposals">;
}

/** The enrollment the file is for. */
export interface EnrolledRuntime {
  scope: { orgId: string; workspaceId: string };
  operator: { userId: string; publicId: string };
  runtime: { slug: string; name: string };
  hostname: string;
  /** The harnesses the host reports, in the order it listed them. */
  harnesses: readonly TachoHarness[];
}

export type AgentFileSkip =
  | "name_invalid"
  | "harness_unknown"
  | "already_proposed"
  | "no_steering_repo"
  | "file_exists"
  | "runtime_has_agent";

export type AgentFileOutcome =
  | {
      status: "opened";
      pullRequest: { number: number; url: string; branch: string; headSha: string };
    }
  | { status: "skipped"; reason: AgentFileSkip };

/** Every status of an agent file proposal that holds the runtime's one PR. */
const HELD = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
  "merged",
] as const;

/** The longest label agent/v1 takes. */
const LABEL_MAX = 80;

/**
 * The harness the file names, and how a person reads it: the first one the
 * host lists that agent/v1 knows. Claude Desktop is a harness a host can
 * report and an agent file cannot name, so a host that reports only it gets
 * no file.
 */
function harnessOf(
  harnesses: readonly TachoHarness[],
): { harness: AgentHarness; label: string } | null {
  for (const reported of harnesses) {
    const read = agentHarnessSchema.safeParse(reported);
    if (read.success) {
      return { harness: read.data, label: TACHO_HARNESS_LABELS[reported] };
    }
  }
  return null;
}

/** True when an agent file on the production branch names `runtime`. */
async function runtimeHasAgent(
  host: Pick<SteeringHost, "readFile" | "listFiles">,
  repo: SteeringRepository,
  runtime: string,
): Promise<boolean> {
  const paths = await host.listFiles(repo, repo.defaultBranch, AGENTS_DIR);
  for (const path of paths) {
    if (!path.endsWith(".toml")) continue;
    const text = await host.readFile(repo, path, repo.defaultBranch);
    if (text === null) continue;
    const read = readTomlFile(text, "agent/v1", agentSchema);
    if (read.ok && read.value.runtime === runtime) return true;
  }
  return false;
}

/** The PR body: why Oxagen opened it and what merging it does. */
function body(input: EnrolledRuntime, name: string, harness: AgentHarness): string {
  const lines = [
    `Oxagen opened this steering PR when a member enrolled the host \`${input.hostname}\` as the runtime \`${input.runtime.slug}\`.`,
    "",
    `It adds \`${agentFilePath(name)}\`, an agent/v1 file that names the member who enrolled the host as its operator, the runtime, and the harness \`${harness}\`. Once it merges, the MCP gateway matches this runtime's runs to the agent and serves them the workspace's published tools.`,
  ];
  if (input.harnesses.length > 1) {
    lines.push(
      "",
      `The host reports ${input.harnesses.length} harnesses (${input.harnesses.join(", ")}). One agent file serves every run on the runtime, and it names the first harness the host listed. Change \`harness\` before you merge if another one fits better.`,
    );
  }
  lines.push(
    "",
    "The file carries no secret. Merge it from Oxagen, so it lands through the merge queue with the stamp and the ledger line.",
  );
  return lines.join("\n");
}

/**
 * Open the steering PR that adds the enrolled runtime's agent file, or say
 * why none was opened. A refusal from the host or the opener is thrown; the
 * caller decides what a failure means for enrollment.
 */
export async function openAgentFilePr(
  deps: AgentFileDeps,
  input: EnrolledRuntime,
): Promise<AgentFileOutcome> {
  const name = agentNameForRuntime(input.runtime.slug);
  if (name === null) return { status: "skipped", reason: "name_invalid" };
  const known = harnessOf(input.harnesses);
  if (known === null) return { status: "skipped", reason: "harness_unknown" };
  const { harness } = known;

  const branch = `${AGENTS_DIR}/${name}`;
  const held = await deps.proposals.listProposals(
    input.scope,
    { lineageId: branch, statuses: HELD },
    { limit: 20, offset: 0 },
  );
  if (held.rows.some((row) => row.kind === "agent_file")) {
    return { status: "skipped", reason: "already_proposed" };
  }

  const host = deps.host();
  let repo: SteeringRepository;
  try {
    repo = await host.resolveRepository(input.scope);
  } catch (err) {
    if (isHandlerError(err) && err.code === "not_found") {
      return { status: "skipped", reason: "no_steering_repo" };
    }
    throw err;
  }
  const path = agentFilePath(name);
  if ((await host.readFile(repo, path, repo.defaultBranch)) !== null) {
    return { status: "skipped", reason: "file_exists" };
  }
  if (await runtimeHasAgent(host, repo, input.runtime.slug)) {
    return { status: "skipped", reason: "runtime_has_agent" };
  }

  const label = `${known.label} on ${input.runtime.name}`
    .slice(0, LABEL_MAX)
    .trimEnd();
  const content = agentFileText({
    schema: "agent/v1",
    name,
    label,
    operator: input.operator.publicId,
    runtime: input.runtime.slug,
    harness,
  });
  const opened = await deps.opener.open(input.scope, {
    branch,
    title: `Add the agent file for runtime ${input.runtime.slug}`,
    body: body(input, name, harness),
    commitMessage: `steering: add the agent ${name}`,
    files: [{ path, content }],
    author: personAuthor(input.operator.userId),
  });
  return { status: "opened", pullRequest: opened };
}

/**
 * openAgentFilePr for enrollment, which never fails on its account: the host
 * is enrolled by the time this runs. A refusal or an error is logged, and a
 * person can still add the file by hand.
 */
export async function openAgentFilePrQuietly(
  deps: AgentFileDeps,
  input: EnrolledRuntime,
): Promise<AgentFileOutcome | null> {
  try {
    const outcome = await openAgentFilePr(deps, input);
    logger.info(
      {
        orgId: input.scope.orgId,
        workspaceId: input.scope.workspaceId,
        runtime: input.runtime.slug,
        ...(outcome.status === "opened"
          ? { pr: outcome.pullRequest.url }
          : { skipped: outcome.reason }),
      },
      outcome.status === "opened"
        ? "agent file: opened the steering PR that adds the enrolled runtime's agent file"
        : "agent file: opened no steering PR for the enrolled runtime",
    );
    return outcome;
  } catch (err) {
    logger.warn(
      {
        err,
        orgId: input.scope.orgId,
        workspaceId: input.scope.workspaceId,
        runtime: input.runtime.slug,
        reason: isHandlerError(err) ? err.reason : null,
      },
      "agent file: the host enrolled, but the steering PR that adds its agent file did not open",
    );
    return null;
  }
}
