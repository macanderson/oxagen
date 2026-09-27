import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotBuiltError, type ManifestServer } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import {
  FIXTURE_ROOT,
  fixtureRepo,
  organizationFixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { countTokens } from "@oxagen/oxagen/steering-repo/tokens";
import { BundleBuildError, buildBundle, type BuildResult, type BundleIdentity } from "./build";
import { ORGANIZATION_BLOCK_HEADING, WORKSPACE_BLOCK_HEADING } from "./render";
import type { ToolCompiler } from "./tools";
import { TreeReader, treeFromFiles, type BlobCache, type SteeringTree } from "./tree";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** S0's stored bundle: what version 21 of the fixture repo publishes. */
const stored = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, "stored", "bundle.json"), "utf8"),
) as Bundle;

const WORKSPACE: BundleIdentity = {
  repository: "github.com/a-intel/oxagen-core-platform",
  scope: "workspace",
  organization: "a-intel",
  workspace: "core-platform",
};

const ORGANIZATION: BundleIdentity = {
  repository: "github.com/a-intel/oxagen",
  scope: "organization",
  organization: "a-intel",
};

const PLATFORM = "github.com/a-intel/platform";
const BILLING_SERVICE = "github.com/a-intel/billing-service";
const REFUNDS = "steering/billing/a-intel.billing.refunds-over-100.md";
const RELEASE_STEPS = "steering/platform/a-intel.platform.release-steps.md";

/** MCP Studio's compile() stands here until lane M4 builds it. */
const refuseCompile: ToolCompiler = () => {
  throw new NotBuiltError("compile");
};

interface BuildOptions {
  identity?: BundleIdentity;
  version?: number;
  previous?: Bundle | null;
  cache?: BlobCache;
  compiler?: ToolCompiler;
  tree?: SteeringTree;
}

async function build(
  files: ReadonlyMap<string, string>,
  options: BuildOptions = {},
): Promise<BuildResult & { reader: TreeReader }> {
  const reader = await TreeReader.open(options.tree ?? treeFromFiles(files), options.cache);
  const result = await buildBundle({
    identity: options.identity ?? WORKSPACE,
    version: options.version ?? stored.version,
    commit: stored.commit,
    published_at: stored.published_at,
    reader,
    previous: options.previous ?? null,
    compiler: options.compiler ?? refuseCompile,
  });
  return { ...result, reader };
}

function edited(path: string, edit: (text: string) => string): Map<string, string> {
  const files = fixtureRepo();
  const text = files.get(path);
  if (text === undefined) throw new Error(`${path} is not in the fixture repo`);
  files.set(path, edit(text));
  return files;
}

function without(...paths: string[]): Map<string, string> {
  const files = fixtureRepo();
  for (const path of paths) files.delete(path);
  return files;
}

async function buildError(run: Promise<unknown>): Promise<BundleBuildError> {
  const error: unknown = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BundleBuildError);
  return error as BundleBuildError;
}

// ── Golden ───────────────────────────────────────────────────────────────────

describe("buildBundle on the fixture repo", () => {
  it("builds S0's stored bundle", async () => {
    const { bundle } = await build(fixtureRepo());
    expect(bundle).toEqual(stored);
  });

  it("renders each code repository's always-on block byte for byte", async () => {
    const { bundle } = await build(fixtureRepo());
    expect(bundle.always_on.map((block) => block.repository)).toEqual([
      PLATFORM,
      BILLING_SERVICE,
      null,
    ]);
    for (const block of stored.always_on) {
      const built = bundle.always_on.find((entry) => entry.repository === block.repository);
      expect(built?.text).toBe(block.text);
      expect(built?.tokens).toBe(countTokens(block.text));
      expect(built?.lineages).toEqual(block.lineages);
    }
  });

  it("pins the block for a repository no workspace.toml entry names", async () => {
    const { bundle } = await build(fixtureRepo());
    const fallback = bundle.always_on.find((block) => block.repository === null);
    expect(fallback?.text).toBe(
      [
        `${WORKSPACE_BLOCK_HEADING}\n`,
        "### Plain words in product copy",
        "Write product copy in short sentences and plain words, with numbers over",
        "adjectives. For anything longer than a sentence, follow",
        "`@skill:a-intel.brand.voice`. Name refund states the way",
        "`@record:a-intel.domain.refund` defines them.\n",
        "### Sentence case headings",
        "Write every heading, button, label, and table header in sentence case.",
        'Capitalize only the first word and proper nouns: "Run cost", not "Run Cost".\n',
        "### Never push to main",
        "Do not push to `main` or force-push any shared branch. Open a pull request",
        "from a branch named for the work.\n",
      ].join("\n"),
    );
    expect(fallback?.tokens).toBe(149);
  });

  it("keeps frontmatter out of every block", async () => {
    const { bundle } = await build(fixtureRepo());
    for (const block of bundle.always_on) {
      expect(block.text).not.toContain("---");
      expect(block.text).not.toContain("lineage:");
      expect(block.text).not.toContain("schema: steering-record/v1");
    }
  });

  it("warns once per server that MCP Studio cannot compile yet, and publishes with no manifest", async () => {
    const { bundle, warnings } = await build(fixtureRepo());
    expect(bundle.tools).toBeNull();
    expect(warnings).toEqual([
      "tools/servers/billing is left out: MCP Studio's compile is not built yet.",
      "tools/servers/stripe is left out: MCP Studio's compile is not built yet.",
    ]);
  });

  it("builds the same bundle whatever order the host lists the tree in", async () => {
    const shuffled = new Map([...fixtureRepo()].reverse());
    const { bundle } = await build(shuffled);
    expect(bundle).toEqual(stored);
  });

  it("builds the same bundle when the host lists no blob ids", async () => {
    const files = fixtureRepo();
    const bare: SteeringTree = {
      list: () => Promise.resolve([...files.keys()].map((path) => ({ path }))),
      read: (path) => treeFromFiles(files).read(path),
    };
    const { bundle } = await build(files, { tree: bare });
    expect(bundle).toEqual(stored);
  });
});

// ── Incremental build ────────────────────────────────────────────────────────

describe("buildBundle with a previous version", () => {
  it("reads only the files the new version needs when the tree is unchanged", async () => {
    const first = await build(fixtureRepo());
    const second = await build(fixtureRepo(), { previous: first.bundle });
    expect(second.bundle).toEqual(first.bundle);
    expect(second.reader.reads).toBeLessThan(first.reader.reads);
  });

  it("reads nothing from the host when the blob cache holds every file", async () => {
    const cache = new Map<string, string>();
    const first = await build(fixtureRepo(), { cache });
    expect(first.reader.reads).toBeGreaterThan(0);
    const second = await build(fixtureRepo(), { cache, previous: first.bundle });
    expect(second.reader.reads).toBe(0);
    expect(second.bundle).toEqual(first.bundle);
  });

  it("reads one file when one record changed, and keeps every other entry", async () => {
    const cache = new Map<string, string>();
    const first = await build(fixtureRepo(), { cache });
    const files = edited(RELEASE_STEPS, (text) => `${text}5. Post the release in the team channel.\n`);
    const second = await build(files, { cache, previous: first.bundle, version: 22 });
    expect(second.reader.reads).toBe(1);

    const before = first.bundle.records.find((entry) => entry.path === RELEASE_STEPS);
    const after = second.bundle.records.find((entry) => entry.path === RELEASE_STEPS);
    expect(after?.blob).not.toBe(before?.blob);
    expect(after?.tokens).toBeGreaterThan(before?.tokens ?? Infinity);
    expect(second.bundle.records.filter((entry) => entry.path !== RELEASE_STEPS)).toEqual(
      first.bundle.records.filter((entry) => entry.path !== RELEASE_STEPS),
    );
    expect(second.bundle.version).toBe(22);
  });

  it("rebuilds a block whose member changed", async () => {
    const first = await build(fixtureRepo());
    const files = edited(REFUNDS, (text) =>
      text.replace("Ask in the run and wait.", "Ask in the run and wait for the answer."),
    );
    const second = await build(files, { previous: first.bundle });
    const block = second.bundle.always_on.find((entry) => entry.repository === BILLING_SERVICE);
    expect(block?.text).toContain("Ask in the run and wait for the answer.");
    expect(block?.tokens).toBe(countTokens(block?.text ?? ""));
  });
});

// ── Tools and mentions ───────────────────────────────────────────────────────

describe("buildBundle with compiled tools", () => {
  const mentioning = (): Map<string, string> =>
    edited(REFUNDS, (text) =>
      text.replace("`billing__create_refund`", "@tool:billing__create_refund"),
    );

  function compileAs(mode: "direct" | "search"): ToolCompiler {
    return (folder) =>
      ({ name: folder.name, exposure: { mode, definition_budget: 8000 } }) as unknown as ManifestServer;
  }

  it("names a direct-mode tool as itself", async () => {
    const { bundle, warnings } = await build(mentioning(), { compiler: compileAs("direct") });
    expect(warnings).toEqual([]);
    const block = bundle.always_on.find((entry) => entry.repository === BILLING_SERVICE);
    expect(block?.text).toContain("before you call\nbilling__create_refund. Ask");
    expect(block?.text).not.toContain("@tool:");
  });

  it("names a search-mode tool through its server's call tool", async () => {
    const { bundle } = await build(mentioning(), { compiler: compileAs("search") });
    const block = bundle.always_on.find((entry) => entry.repository === BILLING_SERVICE);
    expect(block?.text).toContain("call billing__call with tool create_refund");
    expect(block?.tokens).toBe(countTokens(block?.text ?? ""));
  });

  it("names a tool as itself while no server compiles", async () => {
    const { bundle } = await build(mentioning());
    const block = bundle.always_on.find((entry) => entry.repository === BILLING_SERVICE);
    expect(block?.text).toContain("billing__create_refund. Ask");
  });

  it("orders the manifest's servers by the name each compiles to", async () => {
    // billing compiles first, under a name that sorts last.
    const renamed: ToolCompiler = (folder) =>
      ({
        name: folder.name === "billing" ? "zulu" : "alpha",
        exposure: { mode: "direct" },
      }) as unknown as ManifestServer;
    const { bundle } = await build(fixtureRepo(), { compiler: renamed });
    expect(bundle.tools).toEqual({
      schema: "tool-manifest/v1",
      servers: [
        { name: "alpha", exposure: { mode: "direct" } },
        { name: "zulu", exposure: { mode: "direct" } },
      ],
    });
  });

  it("leaves a tool record out of every block when no server imports its tool", async () => {
    const files = without(
      ...[...fixtureRepo().keys()].filter((path) => path.startsWith("tools/servers/billing/")),
    );
    const { bundle } = await build(files);
    const block = bundle.always_on.find((entry) => entry.repository === BILLING_SERVICE);
    expect(block?.lineages).not.toContain("a-intel.billing.refunds-over-100");
    expect(bundle.records.map((entry) => entry.lineage)).toContain(
      "a-intel.billing.refunds-over-100",
    );
  });
});

// ── Organization ─────────────────────────────────────────────────────────────

describe("buildBundle on the organization repo", () => {
  it("renders the organization block for every repository", async () => {
    const { bundle, warnings } = await build(organizationFixtureRepo(), {
      identity: ORGANIZATION,
      version: 1,
    });
    expect(warnings).toEqual([]);
    expect(bundle.scope).toBe("organization");
    expect(bundle).not.toHaveProperty("workspace");
    expect(bundle.policies).toBeNull();
    expect(bundle.agents).toEqual([]);
    expect(bundle.tools).toBeNull();
    expect(bundle.always_on).toEqual([
      {
        repository: null,
        text:
          `${ORGANIZATION_BLOCK_HEADING}\n\n` +
          "### No secrets in code\n" +
          "Do not write a key, a token, or a password into a file or a commit. Read it\n" +
          "from the environment the run provides, and ask a person when it is missing.\n",
        tokens: countTokens(
          `${ORGANIZATION_BLOCK_HEADING}\n\n` +
            "### No secrets in code\n" +
            "Do not write a key, a token, or a password into a file or a commit. Read it\n" +
            "from the environment the run provides, and ask a person when it is missing.\n",
        ),
        lineages: ["a-intel.security.no-secrets-in-code"],
      },
    ]);
  });

  it("renders a block for each repository an organization record names", async () => {
    const files = organizationFixtureRepo();
    const path = "steering/security/a-intel.security.no-secrets-in-code.md";
    const text = files.get(path) ?? "";
    files.set(
      path,
      text.replace("scope: organization\n", `scope: repository\nrepos:\n  - ${PLATFORM}\n`),
    );
    const { bundle } = await build(files, { identity: ORGANIZATION, version: 1 });
    expect(bundle.always_on.map((block) => block.repository)).toEqual([PLATFORM, null]);
    expect(bundle.always_on[0]?.lineages).toEqual(["a-intel.security.no-secrets-in-code"]);
    expect(bundle.always_on[1]?.lineages).toEqual([]);
    expect(bundle.always_on[1]?.text).toBe("");
    expect(bundle.always_on[1]?.tokens).toBe(0);
  });
});

// ── Refusals and warnings ────────────────────────────────────────────────────

describe("buildBundle refusals", () => {
  it("formats each issue with its line", () => {
    const error = new BundleBuildError("steering/x.md", [
      { line: 3, field: "label", message: "label is required" },
      { line: null, field: null, message: "the file has no body" },
    ]);
    expect(error.name).toBe("BundleBuildError");
    expect(error.path).toBe("steering/x.md");
    expect(error.message).toBe(
      "steering/x.md does not read, so the version was not built: line 3: label is required; the file has no body",
    );
  });

  it("refuses a workspace's steering repo with no workspace.toml", async () => {
    const error = await buildError(build(without("workspace.toml")));
    expect(error.path).toBe("workspace.toml");
    expect(error.message).toContain("a workspace's steering repo needs workspace.toml");
  });

  it("refuses a workspace.toml that does not read", async () => {
    const files = fixtureRepo();
    files.set("workspace.toml", 'schema = "workspace/v1"\norganization = 7\n');
    const error = await buildError(build(files));
    expect(error.path).toBe("workspace.toml");
  });

  it("refuses a record that does not read", async () => {
    const files = fixtureRepo();
    files.set(RELEASE_STEPS, "This file lost its frontmatter.\n");
    const error = await buildError(build(files));
    expect(error.path).toBe(RELEASE_STEPS);
  });

  it("refuses an agent file that does not read", async () => {
    const path = "agents/a-intel.core.ci-reviewer.toml";
    const files = fixtureRepo();
    files.set(path, 'schema = "agent/v1"\n');
    const error = await buildError(build(files));
    expect(error.path).toBe(path);
  });

  it("refuses a ledger that does not read", async () => {
    const path = "steering/promotions/2026-09.jsonl";
    const files = fixtureRepo();
    files.set(path, "not a promotion\n");
    const error = await buildError(build(files));
    expect(error.path).toBe(path);
  });

  it("refuses a bundle its schema refuses", async () => {
    const error = await buildError(build(fixtureRepo(), { version: 0 }));
    expect(error.path).toBe("bundle/v1");
    expect(error.issues.map((issue) => issue.field)).toContain("version");
  });

  it("leaves an archived record out", async () => {
    const files = edited(RELEASE_STEPS, (text) => text.replace("status: active", "status: archived"));
    const { bundle } = await build(files);
    expect(bundle.records.map((entry) => entry.path)).not.toContain(RELEASE_STEPS);
    expect(bundle.records).toHaveLength(stored.records.length - 1);
  });

  it("publishes a policy set with no schema when the schema file is missing, and says so", async () => {
    const { bundle, warnings } = await build(without("policy/schema.cedarschema"));
    expect(bundle.policies?.schema).toBe("");
    expect(bundle.policies?.policies.map((policy) => policy.path)).toEqual(["policy/money.cedar"]);
    expect(warnings).toContain(
      "policy/schema.cedarschema is missing, so the policy set has no schema.",
    );
  });

  it("publishes no policy set when the repository has no policy folder", async () => {
    const files = without(
      ...[...fixtureRepo().keys()].filter((path) => path.startsWith("policy/")),
    );
    const { bundle } = await build(files);
    expect(bundle.policies).toBeNull();
  });

  it("publishes no ledger line when the repository has no ledger", async () => {
    const { bundle } = await build(without("steering/promotions/2026-09.jsonl"));
    expect(bundle.ledger).toBeNull();
  });
});
