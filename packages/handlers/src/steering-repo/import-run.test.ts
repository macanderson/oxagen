import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import {
  FIXTURE_ROOT,
  readFixtureTree,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { FakeGitHub, REPO } from "../context.steering.test-support";
import type { SteeringRepository } from "../context.steering.github";
import { githubRepoRef } from "../repository.workspace-toml";
import {
  convertOxagenTree,
  IMPORT_WORKSPACE_BRANCH,
  type ImportAgent,
  type OxagenTreeConversion,
} from "./convert";
import {
  IMPORT_CLEANUP_BRANCH,
  IMPORT_LEASE_MS,
  initialImportState,
  runSteeringImport,
  type ImportResult,
  type ImportSourceRepository,
  type SteeringHeadRead,
  type SteeringImportDeps,
  type SteeringImportState,
} from "./import-run";
import { IMPORT_BRANCH } from "./stamp";

const INPUT = readFixtureTree(join(FIXTURE_ROOT, "v0.1", "input"));
const REFUNDS_RULE = "ctx.a-intel.refunds-over-100";
const CHOICES = { ruleKinds: { [REFUNDS_RULE]: "business-rule" as const } };
const SCOPE = { orgId: "org-a-intel", workspaceId: "ws-core-platform" };
const NAMES = { organization: "a-intel", workspace: "core-platform" };

const OLD_HEAD = "head-old";
const NEW_HEAD = "head-steering";
/** A converted file whose governance section the conversion drops a field from. */
const GOVERNANCE_PATH = ".oxagen/rules/governance.toml";

const SOURCE: ImportSourceRepository = {
  head_id: OLD_HEAD,
  connection_id: "conn-github",
  owner: "a-intel",
  name: "platform",
  full_name: "a-intel/platform",
  default_branch: "main",
};

const STEERING_REPO: SteeringRepository = {
  ...REPO,
  repo: "platform-steering",
  fullName: "a-intel/platform-steering",
  currentFullName: "a-intel/platform-steering",
};

/** The v0.1 tree on the old repository's main, as FakeGitHub seeds it. */
function onMain(tree: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...tree].map(([path, content]) => [`main:${path}`, content]));
}

/** What the converter answers for the fixture, which the run should open verbatim. */
function expectedConversion(agents: ImportAgent[] = []): OxagenTreeConversion {
  const result = convertOxagenTree({
    files: INPUT,
    ...NAMES,
    relinked: githubRepoRef(SOURCE.owner, SOURCE.name),
    ...CHOICES,
    workspaceToml: null,
    governanceToml: null,
    agents,
  });
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.conversion;
}

/**
 * A workspace, its two repositories, and the settings row, in memory. The
 * old repository steers the workspace until a test says otherwise.
 */
class World {
  source = new FakeGitHub(onMain(INPUT));
  steering = new FakeGitHub();
  state: SteeringImportState | null = null;
  heads = new Map<string, "steering" | "linked">([[OLD_HEAD, "steering"]]);
  head: SteeringHeadRead | null = null;
  names = NAMES;
  agents: ImportAgent[] = [];
  clock = new Date("2026-09-28T12:00:00Z");
  provisionCalls = 0;
  demoteCalls = 0;
  /** Set to make provisioning fail; `bound` says whether the bind ran first. */
  provisionFails: { error: HandlerError; bound: boolean } | null = null;
  /** Set to stand for a process that stopped: every write throws. */
  stopped = false;

  constructor() {
    this.steering.repository = STEERING_REPO;
  }

  private readHead(): SteeringHeadRead {
    if (this.head) return this.head;
    if (this.heads.get(NEW_HEAD) === "steering")
      return { kind: "provisioned", fullName: STEERING_REPO.fullName };
    if (this.heads.get(OLD_HEAD) === "steering") return { kind: "repository", ...SOURCE };
    return { kind: "none" };
  }

  private write(state: SteeringImportState) {
    if (this.stopped) throw new Error("the process stopped");
    this.state = structuredClone(state);
  }

  deps(): SteeringImportDeps {
    return {
      now: () => this.clock,
      readState: async () => (this.state ? structuredClone(this.state) : null),
      saveState: async (_scope, state) => this.write(state),
      claim: async (_scope, state, staleBefore) => {
        const held =
          this.state?.status === "running" &&
          Date.parse(this.state.updated_at) > staleBefore.getTime();
        if (held) return false;
        this.write(state);
        return true;
      },
      readSteeringHead: async () => this.readHead(),
      demote: async (_scope, headId) => {
        this.demoteCalls += 1;
        if (!this.heads.has(headId)) return false;
        this.heads.set(headId, "linked");
        return true;
      },
      restore: async (_scope, headId) => {
        if ([...this.heads.values()].includes("steering")) return false;
        if (this.heads.get(headId) !== "linked") return false;
        this.heads.set(headId, "steering");
        return true;
      },
      provision: async () => {
        this.provisionCalls += 1;
        if (this.provisionFails) {
          if (this.provisionFails.bound) this.heads.set(NEW_HEAD, "steering");
          throw this.provisionFails.error;
        }
        this.heads.set(NEW_HEAD, "steering");
      },
      openSource: async () => ({ host: this.source, repo: REPO }),
      openSteering: async () => ({ host: this.steering, repo: STEERING_REPO }),
      agents: async () => this.agents,
      names: async () => this.names,
    };
  }

  run(input: Parameters<typeof runSteeringImport>[1] = CHOICES): Promise<ImportResult> {
    return runSteeringImport(SCOPE, input, this.deps());
  }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isHandlerError(err)) return err.reason;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("runSteeringImport: a workspace steered by .oxagen/", () => {
  it("opens the import steering PRs, the cleanup PR, and leaves the old head linked", async () => {
    const world = new World();
    const expected = expectedConversion();

    const result = await world.run();

    expect(result.outcome).toBe("imported");
    expect(result.steeringRepository).toBe("a-intel/platform-steering");
    expect(world.heads.get(OLD_HEAD)).toBe("linked");
    expect(world.heads.get(NEW_HEAD)).toBe("steering");
    expect(world.provisionCalls).toBe(1);

    // The steering PRs, in merge order, each carrying what the converter wrote.
    expect(world.steering.pulls.map((pr) => pr.head)).toEqual([
      IMPORT_BRANCH,
      IMPORT_WORKSPACE_BRANCH,
    ]);
    expect(world.steering.pulls.map((pr) => pr.title)).toEqual([
      "Import steering from .oxagen/",
      "Import workspace.toml from .oxagen/",
    ]);
    for (const pr of world.steering.pulls) {
      expect(pr.base).toBe("main");
      expect(pr.labels).toEqual(OXAGEN_PR_LABELS);
    }
    expect(world.steering.stamps.map((s) => ({ branch: s.branch, parent: s.parent, files: s.files }))).toEqual(
      expected.branches.map((b) => ({ branch: b.branch, parent: "base0", files: b.files })),
    );
    expect(result.pullRequests).toEqual(
      world.steering.pulls.map((pr) => ({
        branch: pr.head,
        number: pr.number,
        url: `https://github.com/a-intel/platform/pull/${pr.number}`,
      })),
    );

    // The cleanup PR removes the converted files from the old repository.
    expect(world.source.pulls).toHaveLength(1);
    const cleanup = world.source.pulls[0];
    expect(cleanup?.head).toBe(IMPORT_CLEANUP_BRANCH);
    expect(cleanup?.base).toBe("main");
    expect(cleanup?.title).toBe("Remove the .oxagen/ files the steering repo now holds");
    expect(result.cleanup).toEqual({
      number: cleanup?.number,
      url: `https://github.com/a-intel/platform/pull/${cleanup?.number}`,
    });
    expect(world.source.stamps).toHaveLength(1);
    const removed = world.source.stamps[0]?.files ?? [];
    expect(removed.every((file) => file.content === null)).toBe(true);
    expect(removed.map((file) => file.path).sort()).toEqual([...expected.cleanupPaths].sort());
    for (const pr of world.steering.pulls) expect(cleanup?.body).toContain(`\`${pr.head}\``);
    expect(cleanup?.body).not.toContain("## Files changed since the import");

    // Both the first steering PR and the cleanup PR name the dropped fields.
    expect(Object.keys(expected.dropped)).toContain(GOVERNANCE_PATH);
    for (const body of [world.steering.pulls[0]?.body, cleanup?.body]) {
      expect(body).toContain("## Dropped fields");
      expect(body).toContain(`- \`${GOVERNANCE_PATH}\`: \`separation_of_duties\``);
      expect(body).toContain("`workspace.name`");
    }
    expect(world.steering.pulls[1]?.body).not.toContain("## Dropped fields");

    expect(result.leftForAPerson).toBe(
      expected.unconverted.length +
        expected.agentsByHand.length +
        expected.rulesNeedingKind.length +
        expected.constraintsNeedingEffect.length,
    );
    expect(world.state).toMatchObject({
      status: "done",
      step: "cleanup",
      outcome: "imported",
      source: { ...SOURCE, commit: "base0", relinked: "github.com/a-intel/platform" },
      steering_base: "base0",
      cleanup_base: "base0",
      cleanup_kept: [],
    });
  });

  it("answers a finished run again without touching either host", async () => {
    const world = new World();
    const first = await world.run();

    const second = await world.run({});

    expect(second).toEqual(first);
    expect(world.provisionCalls).toBe(1);
    expect(world.demoteCalls).toBe(1);
    expect(world.steering.pulls).toHaveLength(2);
    expect(world.steering.stamps).toHaveLength(2);
    expect(world.source.pulls).toHaveLength(1);
  });

  it("opens the batches, then workspace.toml, then one PR per agent", async () => {
    const world = new World();
    world.agents = [
      { slug: "release-bot", label: "Release bot", operator: "priya", runtime: "ci-linux-01", harness: "codex" },
      { slug: "ci-reviewer", label: "CI reviewer", operator: null, runtime: "ci-linux-01", harness: "codex" },
    ];

    const result = await world.run();

    expect(result.pullRequests.map((pr) => pr.branch)).toEqual([
      IMPORT_BRANCH,
      IMPORT_WORKSPACE_BRANCH,
      "agents/a-intel.core-platform.release-bot",
    ]);
    expect(world.steering.pulls[2]?.title).toBe("Import the agent a-intel.core-platform.release-bot");
    expect(world.steering.pulls[2]?.labels).toEqual(OXAGEN_PR_LABELS);
    // The agent with no operator is left for a person, and the first PR says so.
    const expected = expectedConversion(world.agents);
    expect(expected.agentsByHand.map((agent) => agent.name)).toEqual([
      "a-intel.core-platform.ci-reviewer",
    ]);
    expect(result.leftForAPerson).toBe(expected.unconverted.length + expected.agentsByHand.length);
    expect(world.steering.pulls[0]?.body).toContain("`a-intel.core-platform.ci-reviewer`");
  });
});

describe("runSteeringImport: nothing changes until the conversion is certain", () => {
  it("asks for a kind for each v0.1 rule, and changes nothing", async () => {
    const world = new World();

    const result = await world.run({});

    expect(result).toMatchObject({
      outcome: "needs_choices",
      rulesNeedingKind: [REFUNDS_RULE],
      constraintsNeedingEffect: [],
      pullRequests: [],
      cleanup: null,
    });
    expect(world.heads.get(OLD_HEAD)).toBe("steering");
    expect(world.demoteCalls).toBe(0);
    expect(world.provisionCalls).toBe(0);
    expect(world.steering.pulls).toHaveLength(0);
    expect(world.source.pulls).toHaveLength(0);
    expect(world.state).toMatchObject({ status: "waiting", step: null });

    // The same call with the choice imports.
    expect((await world.run()).outcome).toBe("imported");
  });

  it("refuses a tree the converter cannot read before it changes anything", async () => {
    const world = new World();
    // `billing` is a reserved slug, so `payments` stands for another workspace.
    world.names = { organization: "a-intel", workspace: "payments" };

    expect(await refusal(world.run())).toBe("workspace_mismatch");
    expect(world.heads.get(OLD_HEAD)).toBe("steering");
    expect(world.demoteCalls).toBe(0);
    expect(world.provisionCalls).toBe(0);
    expect(world.state).toMatchObject({
      status: "failed",
      step: null,
      error: { code: "workspace_mismatch" },
    });
  });

  it.each<[SteeringHeadRead, string]>([
    [
      { kind: "unsupported", provider: "gitlab", fullName: "a-intel/platform" },
      "steering_import_provider_unsupported",
    ],
    [{ kind: "unreachable", fullName: "a-intel/platform" }, "steering_import_source_unreachable"],
    [{ kind: "legacy", fullName: "a-intel/platform" }, "steering_import_legacy_connection"],
  ])("refuses a %o head and changes nothing", async (head, reason) => {
    const world = new World();
    world.head = head;

    expect(await refusal(world.run())).toBe(reason);
    expect(world.demoteCalls).toBe(0);
    expect(world.provisionCalls).toBe(0);
    expect(world.heads.get(OLD_HEAD)).toBe("steering");
  });
});

describe("runSteeringImport: workspaces with nothing to read", () => {
  it("only creates the steering repo for a workspace that binds no repository", async () => {
    const world = new World();
    world.heads.clear();

    const result = await world.run({});

    expect(result).toMatchObject({
      outcome: "provisioned",
      steeringRepository: "a-intel/platform-steering",
      pullRequests: [],
      cleanup: null,
    });
    expect(world.provisionCalls).toBe(1);
    expect(world.demoteCalls).toBe(0);
    expect(world.steering.pulls).toHaveLength(0);
    expect(world.source.pulls).toHaveLength(0);
  });

  it("tells a workspace on a legacy connection how to start fresh", async () => {
    const world = new World();
    world.heads.clear();
    world.head = { kind: "legacy", fullName: "a-intel/platform" };

    await expect(world.run({})).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_import_legacy_connection",
      message: expect.stringContaining("startFresh"),
    });
    expect(world.provisionCalls).toBe(0);
  });

  it("gives a workspace on a legacy connection an empty steering repo when it starts fresh", async () => {
    const world = new World();
    world.heads.clear();
    world.head = { kind: "legacy", fullName: "a-intel/platform" };

    const result = await world.run({ startFresh: true });

    expect(result).toMatchObject({
      outcome: "provisioned",
      steeringRepository: "a-intel/platform-steering",
      pullRequests: [],
      cleanup: null,
      leftForAPerson: 0,
    });
    expect(world.provisionCalls).toBe(1);
    expect(world.demoteCalls).toBe(0);
    expect(world.steering.pulls).toHaveLength(0);
    expect(world.source.pulls).toHaveLength(0);
  });

  it("answers nothing_to_import for a workspace that has a steering repo", async () => {
    const world = new World();
    world.heads.set(OLD_HEAD, "linked");
    world.heads.set(NEW_HEAD, "steering");

    const result = await world.run({});

    expect(result).toMatchObject({
      outcome: "nothing_to_import",
      steeringRepository: "a-intel/platform-steering",
    });
    expect(world.provisionCalls).toBe(0);
    expect(world.steering.pulls).toHaveLength(0);
  });
});

describe("runSteeringImport: a stopped run", () => {
  it("resumes after a refused PR without committing any branch twice", async () => {
    const world = new World();
    const open = world.steering.openPullRequest.bind(world.steering);
    let refused = false;
    world.steering.openPullRequest = async (repo, args) => {
      if (args.head === IMPORT_WORKSPACE_BRANCH && !refused) {
        refused = true;
        throw new Error("socket hang up");
      }
      return open(repo, args);
    };

    expect(await refusal(world.run())).toBe("github_refused");
    expect(world.state).toMatchObject({
      status: "failed",
      step: "provision",
      error: { code: "github_refused" },
    });
    expect(world.state?.pull_requests.map((pr) => pr.branch)).toEqual([IMPORT_BRANCH]);
    expect(world.steering.stamps).toHaveLength(2);

    const result = await world.run();

    expect(result.outcome).toBe("imported");
    expect(world.steering.stamps).toHaveLength(2);
    expect(world.steering.pulls.map((pr) => pr.head)).toEqual([
      IMPORT_BRANCH,
      IMPORT_WORKSPACE_BRANCH,
    ]);
    expect(world.demoteCalls).toBe(1);
    expect(world.provisionCalls).toBe(1);
    expect(world.source.pulls).toHaveLength(1);
  });

  it("finds a PR a stopped run opened but never recorded, once the lease lapses", async () => {
    const world = new World();
    const open = world.steering.openPullRequest.bind(world.steering);
    world.steering.openPullRequest = async (repo, args) => {
      const opened = await open(repo, args);
      world.stopped = true;
      return opened;
    };

    await expect(world.run()).rejects.toThrow("the process stopped");
    world.stopped = false;
    world.steering.openPullRequest = open;
    expect(world.state).toMatchObject({ status: "running", step: "provision", pull_requests: [] });
    expect(world.steering.pulls).toHaveLength(1);

    // The stopped run still holds the lease.
    expect(await refusal(world.run())).toBe("steering_import_running");

    world.clock = new Date(world.clock.getTime() + IMPORT_LEASE_MS + 1000);
    const result = await world.run();

    expect(result.outcome).toBe("imported");
    expect(world.steering.pulls.map((pr) => pr.head)).toEqual([
      IMPORT_BRANCH,
      IMPORT_WORKSPACE_BRANCH,
    ]);
    expect(world.steering.stamps).toHaveLength(2);
    expect(result.pullRequests[0]?.number).toBe(world.steering.pulls[0]?.number);
  });

  it("refuses while another run saved within the lease, and leaves its state alone", async () => {
    const world = new World();
    world.state = {
      ...initialImportState(new Date(world.clock.getTime() - 60_000)),
      step: "demote",
    };
    const before = structuredClone(world.state);

    expect(await refusal(world.run())).toBe("steering_import_running");
    expect(world.state).toEqual(before);
    expect(world.demoteCalls).toBe(0);
  });

  it("forgets a source whose binding is gone, so the next run reads the workspace again", async () => {
    const world = new World();
    world.state = {
      ...initialImportState(new Date(world.clock.getTime() - 60_000)),
      status: "failed",
      step: "record_source",
      source: {
        ...SOURCE,
        head_id: "head-gone",
        commit: "base0",
        relinked: "github.com/a-intel/platform",
      },
    };

    expect(await refusal(world.run())).toBe("steering_import_source_gone");
    expect(world.state).toMatchObject({
      status: "failed",
      step: null,
      source: null,
      error: { code: "steering_import_source_gone" },
    });
    expect(world.heads.get(OLD_HEAD)).toBe("steering");
    expect(world.provisionCalls).toBe(0);

    const result = await world.run();

    expect(result.outcome).toBe("imported");
    expect(world.heads.get(OLD_HEAD)).toBe("linked");
    expect(world.state?.source?.head_id).toBe(OLD_HEAD);
  });

  it("keeps the cleanup commit a refused run made, and opens its PR once", async () => {
    const world = new World();
    const open = world.source.openPullRequest.bind(world.source);
    let refused = false;
    world.source.openPullRequest = async (repo, args) => {
      if (!refused) {
        refused = true;
        throw new Error("socket hang up");
      }
      return open(repo, args);
    };

    expect(await refusal(world.run())).toBe("github_refused");
    expect(world.state).toMatchObject({ status: "failed", step: "import", cleanup: null });
    expect(world.source.stamps).toHaveLength(1);
    expect(world.source.pulls).toHaveLength(0);

    const result = await world.run();

    expect(result.outcome).toBe("imported");
    expect(world.source.stamps).toHaveLength(1);
    expect(world.source.pulls.map((pr) => pr.head)).toEqual([IMPORT_CLEANUP_BRANCH]);
    expect(result.cleanup?.number).toBe(world.source.pulls[0]?.number);
  });
});

describe("runSteeringImport: branches the import did not make", () => {
  it("refuses a cleanup branch that holds other changes, and opens no PR from it", async () => {
    const world = new World();
    world.source.heads.set(IMPORT_CLEANUP_BRANCH, "base0");
    world.source.commit(IMPORT_CLEANUP_BRANCH, "README.md", "not the import");

    expect(await refusal(world.run())).toBe("steering_import_branch_taken");
    expect(world.source.pulls).toHaveLength(0);
    expect(world.source.stamps).toHaveLength(0);
    expect(world.state).toMatchObject({
      status: "failed",
      step: "import",
      cleanup: null,
      error: { code: "steering_import_branch_taken" },
    });

    // With the branch deleted, the next run opens the cleanup PR.
    world.source.heads.delete(IMPORT_CLEANUP_BRANCH);
    const result = await world.run();

    expect(result.outcome).toBe("imported");
    expect(world.source.stamps).toHaveLength(1);
    expect(world.source.pulls.map((pr) => pr.head)).toEqual([IMPORT_CLEANUP_BRANCH]);
  });

  it("refuses an import branch that holds other changes, and opens no PR from it", async () => {
    const world = new World();
    world.steering.heads.set(IMPORT_BRANCH, "base0");
    world.steering.commit(IMPORT_BRANCH, "steering/other.md", "not the import");

    expect(await refusal(world.run())).toBe("steering_import_branch_taken");
    expect(world.steering.pulls).toHaveLength(0);
    expect(world.steering.stamps).toHaveLength(0);
    expect(world.source.pulls).toHaveLength(0);
    expect(world.state).toMatchObject({ status: "failed", step: "provision", pull_requests: [] });
  });

  it("names the file limit when the host cannot list the branch's changes", async () => {
    const world = new World();
    world.source.heads.set(IMPORT_CLEANUP_BRANCH, "base0");
    world.source.commit(IMPORT_CLEANUP_BRANCH, "README.md", "one of many");
    world.source.changedFiles = async (_repo, base, head) => {
      throw new HandlerError({
        code: "conflict",
        reason: "too_many_files",
        message: `${head} changes 300 or more files against ${base}.`,
      });
    };

    let caught: unknown;
    try {
      await world.run();
    } catch (err) {
      caught = err;
    }

    expect(isHandlerError(caught) && caught.reason).toBe("steering_import_branch_taken");
    expect((caught as Error).message).toContain(
      `The branch ${IMPORT_CLEANUP_BRANCH} on ${REPO.fullName} already exists and changes 300 or more files.`,
    );
    expect(world.source.pulls).toHaveLength(0);
    expect(world.source.stamps).toHaveLength(0);
  });
});

describe("runSteeringImport: the old repository changes during the run", () => {
  it("keeps a converted file edited after the import read it", async () => {
    const world = new World();
    const expected = expectedConversion();
    expect(expected.cleanupPaths).toContain(GOVERNANCE_PATH);
    const open = world.steering.openPullRequest.bind(world.steering);
    let edited = false;
    world.steering.openPullRequest = async (repo, args) => {
      const opened = await open(repo, args);
      if (!edited) {
        edited = true;
        world.source.commit("main", GOVERNANCE_PATH, "edited after the import read it");
      }
      return opened;
    };

    const result = await world.run();

    expect(result.outcome).toBe("imported");
    const moved = world.source.heads.get("main");
    expect(moved).not.toBe("base0");
    expect(world.source.stamps).toHaveLength(1);
    expect(world.source.stamps[0]?.parent).toBe(moved);
    const removed = (world.source.stamps[0]?.files ?? []).map((file) => file.path);
    expect(removed).not.toContain(GOVERNANCE_PATH);
    expect(removed.sort()).toEqual(
      expected.cleanupPaths.filter((path) => path !== GOVERNANCE_PATH).sort(),
    );

    const body = world.source.pulls[0]?.body ?? "";
    expect(body).toContain("## Files changed since the import");
    expect(body).toContain(`- \`${GOVERNANCE_PATH}\``);
    expect(body).toContain("`base0`");
    // The kept file's dropped field stays with the file, so the cleanup does not list it.
    expect(body).not.toContain("`separation_of_duties`");
    expect(body).toContain("`workspace.name`");

    expect(result.leftForAPerson).toBe(
      expected.unconverted.length +
        expected.agentsByHand.length +
        expected.rulesNeedingKind.length +
        expected.constraintsNeedingEffect.length +
        1,
    );
    expect(world.state).toMatchObject({ cleanup_base: moved, cleanup_kept: [GOVERNANCE_PATH] });
  });
});

describe("runSteeringImport: provisioning fails", () => {
  const failed = new HandlerError({
    code: "conflict",
    reason: "steering_repo_provision_failed",
    message: "GitHub refused the repository.",
  });

  it("puts the old repository back as the steering head", async () => {
    const world = new World();
    world.provisionFails = { error: failed, bound: false };

    expect(await refusal(world.run())).toBe("steering_repo_provision_failed");
    expect(world.heads.get(OLD_HEAD)).toBe("steering");
    expect(world.state).toMatchObject({
      status: "failed",
      step: null,
      error: { code: "steering_repo_provision_failed" },
    });
    expect(world.steering.pulls).toHaveLength(0);
    expect(world.source.pulls).toHaveLength(0);

    world.provisionFails = null;
    const result = await world.run({});

    expect(result.outcome).toBe("imported");
    expect(world.heads.get(OLD_HEAD)).toBe("linked");
  });

  it("keeps the old head linked when the bind already made the steering head", async () => {
    const world = new World();
    world.provisionFails = { error: failed, bound: true };

    expect(await refusal(world.run())).toBe("steering_repo_provision_failed");
    expect(world.heads.get(OLD_HEAD)).toBe("linked");
    expect(world.heads.get(NEW_HEAD)).toBe("steering");
    expect(world.state).toMatchObject({ status: "failed", step: "demote" });

    world.provisionFails = null;
    const result = await world.run({});

    expect(result.outcome).toBe("imported");
    expect(world.demoteCalls).toBe(1);
    expect(world.provisionCalls).toBe(2);
  });
});
