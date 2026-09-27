// The steering PR half of context.steering.checks.ts: the tree loader, the
// adapter over a steering host, and checkSteeringChange(), which hands both
// trees to @oxagen/steering-check.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { bundleSchema } from "@oxagen/oxagen/steering-repo";
import {
  FIXTURE_ROOT,
  fixtureContext,
  fixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { runChecks, type CheckInput } from "@oxagen/steering-check";
import {
  STEERING_TREE_READS_AT_ONCE,
  checkSteeringChange,
  loadSteeringTree,
  steeringTreeHost,
  type SteeringTreeHost,
} from "./context.steering.checks";
import type { SteeringRepository } from "./context.steering.github";

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "2222222222222222222222222222222222222222";

/** The valid record the fixture cases leave alone. */
const VALID_RECORD = "steering/brand/a-intel.brand.plain-words.md";

/** The fixture repo with one word of the valid record changed and its stamp removed. */
function editedRepo(): Map<string, string> {
  const tree = fixtureRepo();
  const text = tree.get(VALID_RECORD);
  if (text === undefined) throw new Error(`${VALID_RECORD} is missing from the fixture repo`);
  const edited = text
    .replace("with numbers over", "with figures over")
    .split("\n")
    .filter((line) => !line.startsWith("id: ") && !line.startsWith("hash: "))
    .join("\n");
  tree.set(VALID_RECORD, edited);
  return tree;
}

/** A host that serves one tree per ref and records every read. */
function treeHost(trees: Record<string, ReadonlyMap<string, string>>) {
  const reads: { ref: string; path: string }[] = [];
  const host: SteeringTreeHost = {
    async listFiles(ref) {
      return [...(trees[ref]?.keys() ?? [])];
    },
    async readFile(ref, path) {
      reads.push({ ref, path });
      return trees[ref]?.get(path) ?? null;
    },
  };
  return { host, reads };
}

function fixtureIndex(): CheckInput["index"] {
  const bundle = bundleSchema.parse(
    JSON.parse(readFileSync(join(FIXTURE_ROOT, "stored", "bundle.json"), "utf8")),
  );
  return { records: bundle.records };
}

function context(): CheckInput["context"] {
  const { runtimes, members, teams, groups, credentials } = fixtureContext();
  return { runtimes, members, teams, groups, credentials };
}

describe("checkSteeringChange", () => {
  it("reports what runChecks() reports on the same two trees", async () => {
    const head = editedRepo();
    const base = fixtureRepo();
    const { host } = treeHost({ [HEAD]: head, [BASE]: base });
    const shared = {
      index: fixtureIndex(),
      context: context(),
      health: { differences: [] },
    };

    const report = await checkSteeringChange({ host, head: HEAD, base: BASE, ...shared });

    expect(report).toEqual(runChecks({ files: head, base, ...shared }));
    expect(report.passed).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("reads the head at the head commit and the base at the base commit", async () => {
    const head = editedRepo();
    const base = fixtureRepo();
    const { host, reads } = treeHost({ [HEAD]: head, [BASE]: base });

    await checkSteeringChange({
      host,
      head: HEAD,
      base: BASE,
      index: null,
      context: context(),
      health: null,
    });

    expect(reads.filter((read) => read.ref === HEAD)).toHaveLength(head.size);
    expect(reads.filter((read) => read.ref === BASE)).toHaveLength(base.size);
  });

  it("checks the head tree whole when there is no base", async () => {
    const head = editedRepo();
    const { host, reads } = treeHost({ [HEAD]: head });
    const shared = { index: null, context: context(), health: null };

    const report = await checkSteeringChange({ host, head: HEAD, base: null, ...shared });

    expect(report).toEqual(runChecks({ files: head, base: null, ...shared }));
    expect(reads.every((read) => read.ref === HEAD)).toBe(true);
  });

  it("passes the check selection through", async () => {
    const { host } = treeHost({ [HEAD]: editedRepo(), [BASE]: fixtureRepo() });

    const report = await checkSteeringChange({
      host,
      head: HEAD,
      base: BASE,
      index: null,
      context: context(),
      health: null,
      checks: ["schema"],
    });

    const ran = report.results.filter((result) => result.status !== "skipped");
    expect(ran.map((result) => result.check)).toEqual(["schema"]);
  });

  it("stops when a listed file cannot be read", async () => {
    const host: SteeringTreeHost = {
      listFiles: async () => [VALID_RECORD],
      readFile: async () => null,
    };

    await expect(
      checkSteeringChange({
        host,
        head: HEAD,
        base: BASE,
        index: null,
        context: context(),
        health: null,
      }),
    ).rejects.toBeInstanceOf(HandlerError);
  });
});

describe("loadSteeringTree", () => {
  it("returns every listed file once, in path order", async () => {
    const host: SteeringTreeHost = {
      listFiles: async () => ["b.md", "a.md", "b.md"],
      readFile: async (_ref, path) => `text of ${path}`,
    };

    const tree = await loadSteeringTree(host, HEAD);

    expect([...tree]).toEqual([
      ["a.md", "text of a.md"],
      ["b.md", "text of b.md"],
    ]);
  });

  it("returns an empty tree when the host lists nothing", async () => {
    const { host, reads } = treeHost({});

    const tree = await loadSteeringTree(host, HEAD);

    expect(tree.size).toBe(0);
    expect(reads).toEqual([]);
  });

  it("names the file and the commit when a listed file reads as missing", async () => {
    const host: SteeringTreeHost = {
      listFiles: async () => ["steering/gone.md"],
      readFile: async () => null,
    };

    const error: unknown = await loadSteeringTree(host, HEAD).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HandlerError);
    expect(error).toMatchObject({
      code: "conflict",
      reason: "steering_tree_moved",
      message: `Oxagen listed steering/gone.md at ${HEAD} and then could not read it. The branch may have moved during the read. Run the checks again.`,
    });
  });

  it(`keeps at most ${STEERING_TREE_READS_AT_ONCE} reads in flight`, async () => {
    const paths = Array.from({ length: 30 }, (_, index) => `steering/record-${index}.md`);
    let inFlight = 0;
    let most = 0;
    const host: SteeringTreeHost = {
      listFiles: async () => paths,
      async readFile(_ref, path) {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return path;
      },
    };

    const tree = await loadSteeringTree(host, HEAD);

    expect(tree.size).toBe(30);
    expect(most).toBe(STEERING_TREE_READS_AT_ONCE);
  });
});

describe("steeringTreeHost", () => {
  const repo: SteeringRepository = {
    provider: "github",
    owner: "a-intel",
    repo: "a-intel-steering",
    fullName: "a-intel/a-intel-steering",
    currentFullName: "a-intel/a-intel-steering",
    defaultBranch: "main",
  };

  /** A steering host over the fixture repo that lists folders the way GitHub's does. */
  function fixtureHost(tree: ReadonlyMap<string, string>) {
    const calls: { method: "listFiles" | "readFile"; ref: string; arg: string }[] = [];
    const host = {
      async listFiles(on: SteeringRepository, ref: string, dir: string) {
        expect(on).toBe(repo);
        calls.push({ method: "listFiles" as const, ref, arg: dir });
        return [...tree.keys()].filter((path) => path.startsWith(`${dir}/`));
      },
      async readFile(on: SteeringRepository, path: string, ref: string) {
        expect(on).toBe(repo);
        calls.push({ method: "readFile" as const, ref, arg: path });
        return tree.get(path) ?? null;
      },
    };
    return { host, calls };
  }

  it("lists every file of the fixture repo", async () => {
    const tree = fixtureRepo();
    const { host } = fixtureHost(tree);

    const listed = await steeringTreeHost(host, repo).listFiles(HEAD);

    expect([...listed].sort()).toEqual([...tree.keys()].sort());
  });

  it("lists the four folders and reads each root file at the ref", async () => {
    const { host, calls } = fixtureHost(fixtureRepo());

    await steeringTreeHost(host, repo).listFiles(HEAD);

    expect(calls.every((call) => call.ref === HEAD)).toBe(true);
    expect(calls.filter((call) => call.method === "listFiles").map((call) => call.arg)).toEqual([
      "agents",
      "steering",
      "tools",
      "policy",
    ]);
    expect(calls.filter((call) => call.method === "readFile").map((call) => call.arg)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      ".gitattributes",
      "workspace.toml",
    ]);
  });

  it("leaves out a root file the ref does not have", async () => {
    const tree = fixtureRepo();
    tree.delete("README.md");
    const { host } = fixtureHost(tree);

    const listed = await steeringTreeHost(host, repo).listFiles(HEAD);

    expect(listed).not.toContain("README.md");
    expect(listed).toContain("AGENTS.md");
  });

  it("reads each root file from the host once", async () => {
    const tree = fixtureRepo();
    const { host, calls } = fixtureHost(tree);
    const adapter = steeringTreeHost(host, repo);

    const loaded = await loadSteeringTree(adapter, HEAD);

    expect([...loaded]).toEqual([...tree].sort(([a], [b]) => (a < b ? -1 : 1)));
    const agentsReads = calls.filter((call) => call.method === "readFile" && call.arg === "AGENTS.md");
    expect(agentsReads).toHaveLength(1);
  });

  it("reads a root file from the host again after the kept text is used", async () => {
    const tree = fixtureRepo();
    const { host, calls } = fixtureHost(tree);
    const adapter = steeringTreeHost(host, repo);

    await adapter.listFiles(HEAD);
    const first = await adapter.readFile(HEAD, "AGENTS.md");
    const second = await adapter.readFile(HEAD, "AGENTS.md");

    expect(first).toBe(tree.get("AGENTS.md"));
    expect(second).toBe(tree.get("AGENTS.md"));
    const agentsReads = calls.filter((call) => call.method === "readFile" && call.arg === "AGENTS.md");
    expect(agentsReads).toHaveLength(2);
  });

  it("reads a file under a folder at the ref it is asked for", async () => {
    const tree = fixtureRepo();
    const { host, calls } = fixtureHost(tree);

    const text = await steeringTreeHost(host, repo).readFile(BASE, VALID_RECORD);

    expect(text).toBe(tree.get(VALID_RECORD));
    expect(calls).toEqual([{ method: "readFile", ref: BASE, arg: VALID_RECORD }]);
  });
});
