import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NotBuiltError } from "@oxagen/mcp-studio";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import {
  fixtureRepo,
  organizationFixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { countTokens } from "@oxagen/oxagen/steering-repo/tokens";
import { buildBundle, type BundleIdentity } from "./build";
import { recordBodyReader, type ReadFile } from "./read";
import {
  blockFor,
  blockHeading,
  importedToolNames,
  INDEX_HEADING,
  INDEX_LEAD,
  indexLine,
  indexTokens,
  ORGANIZATION_BLOCK_HEADING,
  recordSection,
  recordTokens,
  renderBlock,
  renderRequest,
  REQUEST_HEADING,
  WORKSPACE_BLOCK_HEADING,
  type Delivery,
  type ReadBody,
  type RequestContext,
} from "./render";
import { TreeReader, treeFromFiles } from "./tree";

// ── Fixture versions ─────────────────────────────────────────────────────────

const PLATFORM = "github.com/a-intel/platform";
const BILLING_SERVICE = "github.com/a-intel/billing-service";

async function publish(
  files: ReadonlyMap<string, string>,
  identity: BundleIdentity,
  version: number,
  commit: string,
): Promise<Bundle> {
  const { bundle } = await buildBundle({
    identity,
    version,
    commit,
    published_at: "2026-09-24T10:00:30Z",
    reader: await TreeReader.open(treeFromFiles(files)),
    previous: null,
    compiler: () => {
      throw new NotBuiltError("compile");
    },
  });
  return bundle;
}

const workspaceFiles = fixtureRepo();
const organizationFiles = organizationFixtureRepo();

const workspace = await publish(
  workspaceFiles,
  {
    repository: "github.com/a-intel/oxagen-core-platform",
    scope: "workspace",
    organization: "a-intel",
    workspace: "core-platform",
  },
  21,
  "b5518188b20ddf02f905fadeaa50d9976abdcc90",
);

const organization = await publish(
  organizationFiles,
  { repository: "github.com/a-intel/oxagen", scope: "organization", organization: "a-intel" },
  4,
  "0123456789abcdef0123456789abcdef01234567",
);

const delivery: Delivery = { workspace, organization };

const readFile: ReadFile = (source, _bundle, file) => {
  const text = (source === "workspace" ? workspaceFiles : organizationFiles).get(file.path);
  return text === undefined
    ? Promise.reject(new Error(`${file.path} is not in the fixture`))
    : Promise.resolve(text);
};

const readBody = recordBodyReader(delivery, readFile);

function record(bundle: Bundle, lineage: string): BundleRecord {
  const found = bundle.records.find((entry) => entry.lineage === lineage);
  if (found === undefined) throw new Error(`${lineage} is not in the version`);
  return found;
}

// ── The golden request ───────────────────────────────────────────────────────

const ORGANIZATION_BLOCK = [
  `${ORGANIZATION_BLOCK_HEADING}\n`,
  "### No secrets in code",
  "Do not write a key, a token, or a password into a file or a commit. Read it",
  "from the environment the run provides, and ask a person when it is missing.\n",
].join("\n");

const WORKSPACE_BLOCK = [
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
].join("\n");

const INDEX = [
  "",
  `${INDEX_HEADING}\n`,
  INDEX_LEAD,
  "- Brand voice: Write customer-facing copy in the a-intel voice, with the words it uses and the ones it avoids. (a-intel.brand.voice)",
  "- House UI: Build or change UI in a-intel apps with the house tokens and components. (a-intel.design.house-ui)",
  "- Refund: What a refund is at a-intel, its states, and the tools that change it. (a-intel.domain.refund)",
  "- Production deploys from main: Which branch deploys to production, and when. (a-intel.platform.production-branch)",
  "- Release steps: How to cut a release of the platform service. (a-intel.platform.release-steps)",
  "- Write a database migration: Write and check an Atlas migration for a schema change in packages/database. (a-intel.platform.write-migration)\n",
].join("\n");

const TENANT_RULE = [
  "",
  `${REQUEST_HEADING}\n`,
  "### Tenant queries use withTenantDb",
  "Every query that reads or writes a tenant table goes through",
  "`withTenantDb(ctx, fn)`. Never call `db()` directly in a handler.",
  "",
  "```ts",
  "await withTenantDb(ctx, (tx) => tx.select().from(runs).where(eq(runs.id, id)));",
  "```\n",
].join("\n");

const HANDLER_EDIT: RequestContext = {
  repository: PLATFORM,
  files: ["packages/handlers/src/run.ts"],
};

describe("renderRequest on the fixture versions", () => {
  it("renders the organization block, the workspace block, the index, then the request's rules", async () => {
    const rendered = await renderRequest(delivery, HANDLER_EDIT, readBody);
    expect(rendered.text).toBe(`${ORGANIZATION_BLOCK}\n${WORKSPACE_BLOCK}${INDEX}${TENANT_RULE}`);
    expect(rendered.prefix_length).toBe(`${ORGANIZATION_BLOCK}\n${WORKSPACE_BLOCK}${INDEX}`.length);
  });

  it("renders the same bytes for two requests of one version", async () => {
    const first = await renderRequest(delivery, HANDLER_EDIT, readBody);
    const second = await renderRequest(delivery, { ...HANDLER_EDIT }, readBody);
    expect(second.text).toBe(first.text);
    expect(second.prefix_length).toBe(first.prefix_length);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.manifest.text_digest).toBe(first.manifest.text_digest);
  });

  it("keeps the shared prefix when two requests of a run touch different files", async () => {
    const edit = await renderRequest(delivery, HANDLER_EDIT, readBody);
    const read = await renderRequest(delivery, { repository: PLATFORM, files: [] }, readBody);
    expect(read.prefix_length).toBe(edit.prefix_length);
    expect(read.text).toBe(edit.text.slice(0, edit.prefix_length));
    expect(read.text).not.toContain(REQUEST_HEADING);
  });

  it("names the versions, the repository, and every record the request received", async () => {
    const { manifest, text } = await renderRequest(delivery, HANDLER_EDIT, readBody);
    expect(manifest.workspace_version).toBe(21);
    expect(manifest.organization_version).toBe(4);
    expect(manifest.repository).toBe(PLATFORM);
    expect(manifest.tokens).toBe(countTokens(text));
    expect(manifest.text_digest).toBe(
      `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    );
    expect(manifest.added.map((entry) => [entry.source, entry.as, entry.lineage])).toEqual([
      ["organization", "body", "a-intel.security.no-secrets-in-code"],
      ["workspace", "body", "a-intel.brand.plain-words"],
      ["workspace", "body", "a-intel.platform.headings-sentence-case"],
      ["workspace", "body", "a-intel.platform.no-push-to-main"],
      ["workspace", "index", "a-intel.brand.voice"],
      ["workspace", "index", "a-intel.design.house-ui"],
      ["workspace", "index", "a-intel.domain.refund"],
      ["workspace", "index", "a-intel.platform.production-branch"],
      ["workspace", "index", "a-intel.platform.release-steps"],
      ["workspace", "index", "a-intel.platform.write-migration"],
      ["workspace", "body", "a-intel.platform.tenant-queries"],
    ]);
    const tenant = record(workspace, "a-intel.platform.tenant-queries");
    expect(manifest.added.at(-1)?.tokens).toBe(tenant.tokens);
    const voice = record(workspace, "a-intel.brand.voice");
    expect(manifest.added[4]?.tokens).toBe(voice.index_tokens);
  });

  it("gives the billing service its own block, with the refund rule", async () => {
    const { text } = await renderRequest(delivery, { repository: BILLING_SERVICE }, readBody);
    expect(text).toContain("### Refunds over $100\n");
    expect(text).not.toContain("- Production deploys from main");
  });

  it("falls back to the block for no repository", async () => {
    const { text, manifest } = await renderRequest(
      delivery,
      { repository: "github.com/a-intel/mobile" },
      readBody,
    );
    expect(text.startsWith(`${ORGANIZATION_BLOCK}\n${WORKSPACE_BLOCK}`)).toBe(true);
    expect(text).not.toContain("Release steps");
    expect(manifest.repository).toBe("github.com/a-intel/mobile");
  });

  it("never sends frontmatter to the model", async () => {
    const { text } = await renderRequest(
      delivery,
      {
        repository: PLATFORM,
        files: ["pnpm-lock.yaml", "packages/database/src/runs.ts"],
        skill: "a-intel.platform.write-migration",
      },
      readBody,
    );
    expect(text).not.toMatch(/^---$/m);
    expect(text).not.toContain("schema: steering-record/v1");
    expect(text).not.toContain("provenance:");
  });
});

// ── Request rules ────────────────────────────────────────────────────────────

describe("renderRequest's request rules", () => {
  it("fires a match record on a file its globs match", async () => {
    const { text, manifest } = await renderRequest(
      delivery,
      { repository: PLATFORM, files: [".github/workflows/ci.yml"] },
      readBody,
    );
    expect(text).toContain("### CI cache key includes the lockfile\n");
    expect(text).not.toContain("### Tenant queries use withTenantDb");
    expect(manifest.added.at(-1)?.lineage).toBe("a-intel.platform.ci-cache-key");
  });

  it("orders fired records by lineage", async () => {
    const { text } = await renderRequest(
      delivery,
      { repository: PLATFORM, files: ["packages/database/src/runs.ts", "pnpm-lock.yaml"] },
      readBody,
    );
    expect(text.indexOf("### CI cache key")).toBeLessThan(text.indexOf("### Tenant queries"));
  });

  it("brings in a skill's always-on record only while that skill runs", async () => {
    const without = await renderRequest(delivery, { repository: PLATFORM }, readBody);
    expect(without.text).not.toContain("### Name a migration for its table");
    const withSkill = await renderRequest(
      delivery,
      { repository: PLATFORM, skill: "a-intel.platform.write-migration" },
      readBody,
    );
    expect(withSkill.text).toContain(
      `${REQUEST_HEADING}\n\n### Name a migration for its table\n` +
        "Name each migration for the table it changes and what it does to it, such as\n" +
        "`runs_add_origin_message`. One migration changes one table.\n",
    );
    expect(withSkill.prefix_length).toBe(without.prefix_length);
  });

  it("lists a skill's relevant record as an index line after the skill's bodies", async () => {
    const note: BundleRecord = {
      ...record(workspace, "a-intel.platform.release-steps"),
      lineage: "a-intel.platform.migration-review",
      label: "Migration review",
      description: "Who reviews a migration before it merges.",
      skills: ["a-intel.platform.write-migration"],
      load: "relevant",
    };
    const withNote: Delivery = {
      ...delivery,
      workspace: { ...workspace, records: [...workspace.records, note] },
    };
    const { text, manifest } = await renderRequest(
      withNote,
      { repository: PLATFORM, skill: "a-intel.platform.write-migration" },
      readBody,
    );
    expect(text.endsWith(
      "`runs_add_origin_message`. One migration changes one table.\n\n" +
        "- Migration review: Who reviews a migration before it merges. (a-intel.platform.migration-review)\n",
    )).toBe(true);
    expect(manifest.added.at(-1)).toEqual({
      lineage: "a-intel.platform.migration-review",
      as: "index",
      tokens: note.index_tokens,
      source: "workspace",
    });
    const other = await renderRequest(withNote, { repository: PLATFORM }, readBody);
    expect(other.text).not.toContain("Migration review");
  });

  it("lists a skill's mention record when no body fires", async () => {
    const note: BundleRecord = {
      ...record(workspace, "a-intel.platform.release-steps"),
      lineage: "a-intel.platform.migration-review",
      label: "Migration review",
      skills: ["a-intel.design.house-ui"],
      load: "mention",
    };
    const withNote: Delivery = {
      ...delivery,
      workspace: { ...workspace, records: [...workspace.records, note] },
    };
    const { text } = await renderRequest(
      withNote,
      { repository: PLATFORM, skill: "a-intel.design.house-ui" },
      readBody,
    );
    expect(text.endsWith(`\n${REQUEST_HEADING}\n\n${indexLine(note)}\n`)).toBe(true);
  });

  it("renders a fired record's tool mentions in its version's modes", async () => {
    const searched: Bundle = {
      ...workspace,
      tools: {
        schema: "tool-manifest/v1",
        servers: [{ name: "billing", exposure: { mode: "search" }, tools: {} }],
      },
    };
    const body: ReadBody = () => Promise.resolve("Refund with @tool:billing__create_refund.");
    const { text } = await renderRequest(
      { workspace: searched, organization: null },
      { repository: PLATFORM, files: ["pnpm-lock.yaml"], tools: ["billing__create_refund"] },
      body,
    );
    expect(text).toContain("Refund with call billing__call with tool create_refund.");
  });

  it("starts with the request's rules when no version has a block or an index", async () => {
    const tenant = record(workspace, "a-intel.platform.tenant-queries");
    const bare: Bundle = { ...workspace, always_on: [], records: [tenant] };
    const { text, prefix_length } = await renderRequest(
      { workspace: bare, organization: null },
      HANDLER_EDIT,
      readBody,
    );
    expect(prefix_length).toBe(0);
    expect(text.startsWith(`${REQUEST_HEADING}\n\n### Tenant queries use withTenantDb\n`)).toBe(true);
  });
});

// ── Targets ──────────────────────────────────────────────────────────────────

describe("renderRequest's targets", () => {
  it("leaves out a tool record when the run holds none of its tools", async () => {
    const { text } = await renderRequest(
      delivery,
      { repository: PLATFORM, tools: ["stripe__list_charges"] },
      readBody,
    );
    expect(text).not.toContain("(a-intel.domain.refund)");
  });

  it("keeps a tool record when the run holds a tool it names", async () => {
    const { text } = await renderRequest(
      delivery,
      { repository: PLATFORM, tools: ["billing__get_refund"] },
      readBody,
    );
    expect(text).toContain("(a-intel.domain.refund)");
  });

  it("reads the run's tools from the manifest once the tools compile", async () => {
    const compiled: Bundle = {
      ...workspace,
      tools: {
        schema: "tool-manifest/v1",
        servers: [{ name: "stripe", exposure: { mode: "direct" }, tools: { list_charges: {} } }],
      },
    };
    const { text } = await renderRequest(
      { workspace: compiled, organization: null },
      { repository: PLATFORM },
      readBody,
    );
    expect(text).not.toContain("(a-intel.domain.refund)");
  });

  it("indexes a mention record only when a block mentions it", async () => {
    const mentionOnly = (lineage: string): Bundle => ({
      ...workspace,
      records: workspace.records.map((entry) =>
        entry.lineage === lineage ? { ...entry, load: "mention" } : entry,
      ),
    });
    const mentioned = await renderRequest(
      { workspace: mentionOnly("a-intel.domain.refund"), organization: null },
      { repository: PLATFORM },
      readBody,
    );
    expect(mentioned.text).toContain("(a-intel.domain.refund)");
    const unmentioned = await renderRequest(
      { workspace: mentionOnly("a-intel.platform.production-branch"), organization: null },
      { repository: PLATFORM },
      readBody,
    );
    expect(unmentioned.text).not.toContain("(a-intel.platform.production-branch)");
  });

  it("renders nothing when no version is published", async () => {
    const rendered = await renderRequest(
      { workspace: null, organization: null },
      HANDLER_EDIT,
      readBody,
    );
    expect(rendered.text).toBe("");
    expect(rendered.prefix_length).toBe(0);
    expect(rendered.manifest).toEqual({
      workspace_version: null,
      organization_version: null,
      repository: PLATFORM,
      added: [],
      tokens: 0,
      text_digest: `sha256:${createHash("sha256").update("", "utf8").digest("hex")}`,
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

describe("render helpers", () => {
  it("writes an index line with and without a description", () => {
    expect(indexLine({ label: "Refund", description: "What a refund is.", lineage: "a.b.c" })).toBe(
      "- Refund: What a refund is. (a.b.c)",
    );
    expect(indexLine({ label: "Refund", lineage: "a.b.c" })).toBe("- Refund (a.b.c)");
    expect(indexTokens({ label: "Refund", lineage: "a.b.c" })).toBe(countTokens("- Refund (a.b.c)"));
  });

  it("counts a record's tokens over its heading and trimmed body", () => {
    expect(recordTokens("Refund", "\n\nA refund returns money.\n\n")).toBe(
      countTokens("### Refund\nA refund returns money.\n"),
    );
    expect(recordSection("Refund", "\nCall @tool:billing__create_refund.\n", new Map())).toBe(
      "### Refund\nCall billing__create_refund.\n",
    );
  });

  it("renders an empty block as empty text", () => {
    expect(renderBlock(WORKSPACE_BLOCK_HEADING, [])).toBe("");
    expect(renderBlock(WORKSPACE_BLOCK_HEADING, ["### A\nB\n", "### C\nD\n"])).toBe(
      `${WORKSPACE_BLOCK_HEADING}\n\n### A\nB\n\n### C\nD\n`,
    );
  });

  it("heads each scope's block", () => {
    expect(blockHeading("workspace")).toBe(WORKSPACE_BLOCK_HEADING);
    expect(blockHeading("organization")).toBe(ORGANIZATION_BLOCK_HEADING);
  });

  it("finds a repository's block, then the block for none, then nothing", () => {
    expect(blockFor(workspace, PLATFORM)?.repository).toBe(PLATFORM);
    expect(blockFor(workspace, "github.com/a-intel/mobile")?.repository).toBeNull();
    const named = { ...workspace, always_on: workspace.always_on.filter((block) => block.repository !== null) };
    expect(blockFor(named, "github.com/a-intel/mobile")).toBeNull();
  });

  it("lists the imported tools a manifest names, or null before the tools compile", () => {
    expect(importedToolNames({ tools: null })).toBeNull();
    expect(importedToolNames({ tools: { schema: "tool-manifest/v1" } })).toBeNull();
    expect(
      importedToolNames({
        tools: {
          schema: "tool-manifest/v1",
          servers: [
            { name: "billing", tools: { create_refund: {}, get_refund: {} } },
            { name: 7, tools: { skipped: {} } },
            { name: "stripe" },
          ],
        },
      }),
    ).toEqual(["billing__create_refund", "billing__get_refund"]);
  });
});
