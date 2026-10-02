// tacho-host-cedar.test-support.ts: a published steering version with Cedar
// policies, for the tests of the Cedar part of a host's bundle (lane S12,
// #4445).
//
// Two agents run on the host's runtime: a release bot in Claude Code, which
// the policy forbids the shell, and a reviewer in Codex, which it does not. A
// third agent runs on another runtime, so a host's part leaves it out.
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type { TachoPublished } from "../tacho.published";

/** The runtime the host binds, which two of the agents run on. */
export const CEDAR_RUNTIME = "laptop-7";
/** The Claude Code agent the policy forbids the shell. */
export const RELEASE_BOT = "acme.core.release-bot";
/** The Codex agent on the same runtime, which the policy leaves alone. */
export const REVIEWER = "acme.core.reviewer";
/** An agent on another runtime. */
export const CI_BOT = "acme.core.ci-bot";

/** The id of the rule that forbids the release bot the shell. */
export const NO_SHELL_ID = "shell.not-for-release-bot";
/** The id of the rule a second version adds, which forbids the reviewer the shell too. */
export const REVIEWER_NO_SHELL_ID = "shell.not-for-reviewer";

const NO_SHELL = `@id("${NO_SHELL_ID}")
forbid (principal, action == Action::"builtin__shell", resource)
when { principal == Agent::"${RELEASE_BOT}" };`;

const REVIEWER_NO_SHELL = `@id("${REVIEWER_NO_SHELL_ID}")
forbid (principal, action == Action::"builtin__shell", resource)
when { principal == Agent::"${REVIEWER}" };`;

/** Policy text Cedar cannot parse. */
export const BROKEN_POLICY = `@id("broken")
forbidd (principal, action, resource);`;

const BLOB = "b10b000000000000000000000000000000000001";

/**
 * A published version of the workspace's steering repo. Version 1 forbids
 * the release bot the shell. Version 2 also forbids the reviewer.
 *
 * Built as a plain object and cast, as the other version fixtures are: the
 * reader reads only the fields set here.
 */
export function cedarVersion(
  options: {
    version?: 1 | 2;
    /** Replaces the policy files. */
    policies?: string[];
    /** Leaves the workspace slug off, as an organization repo's version does. */
    organization?: boolean;
  } = {},
): Bundle {
  const version = options.version ?? 1;
  const texts =
    options.policies ??
    (version === 1 ? [NO_SHELL] : [NO_SHELL, REVIEWER_NO_SHELL]);
  return {
    schema: "bundle/v1",
    repository: "github.com/acme/steering",
    scope: options.organization === true ? "organization" : "workspace",
    organization: "acme",
    ...(options.organization === true ? {} : { workspace: "core" }),
    version,
    commit: `c0ffee${String(version).padStart(34, "0")}`,
    ledger: null,
    published_at: "2026-10-02T09:00:00.000Z",
    records: [],
    always_on: [],
    policies: {
      schema: "",
      policies: texts.map((text, i) => ({
        path: `policy/rule-${i + 1}.cedar`,
        blob: BLOB,
        text,
      })),
    },
    agents: [
      {
        schema: "agent/v1",
        name: RELEASE_BOT,
        label: "Release bot",
        operator: "priya",
        runtime: CEDAR_RUNTIME,
        harness: "claude-code",
      },
      {
        schema: "agent/v1",
        name: REVIEWER,
        label: "Reviewer",
        operator: "platform-team",
        runtime: CEDAR_RUNTIME,
        harness: "codex",
      },
      {
        schema: "agent/v1",
        name: CI_BOT,
        label: "CI bot",
        operator: "platform-team",
        runtime: "ci-linux-01",
        harness: "claude-code",
      },
    ],
    tools: null,
  } as unknown as Bundle;
}

/** A port that serves one published version, which a test can replace, and counts the reads. */
export interface CedarPort extends TachoPublished {
  /** The workspace's published version, or null before the first. */
  version: Bundle | null;
  reads: number;
}

export function cedarPort(version: Bundle | null = cedarVersion()): CedarPort {
  const port: CedarPort = {
    version,
    reads: 0,
    published: async () => {
      port.reads += 1;
      return { workspace: port.version, organization: null };
    },
    readAsset: async (_source, _bundle, file) => {
      throw new Error(`${file.path} is not read by the Cedar tests.`);
    },
  };
  return port;
}
