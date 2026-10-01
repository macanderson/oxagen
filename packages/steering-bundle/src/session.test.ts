// session.test.ts: which skills reach a run, and the folder name each one
// gets. Placing and removing them is `@oxagen/recorder/skills`, tested there.
//
// The runSkills tests build real published versions from the fixture repos,
// with a compiler that throws NotBuiltError, so no MCP Studio code runs.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NotBuiltError } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import {
  fixtureRepo,
  organizationFixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { parseFrontmatter, splitRecordFile } from "@oxagen/oxagen/steering-repo/record";
import {
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
  skillDigest,
  skillMarkdown,
} from "@oxagen/recorder/skills";
import { buildBundle, type BundleIdentity } from "./build";
import { RecordFileError } from "./read";
import type { BundleSource } from "./render";
import { runSkills, skillFolderName, type ReadAsset } from "./session";
import type { ToolCompiler } from "./tools";
import { gitBlobId, TreeReader, treeFromFiles } from "./tree";

// ── skillFolderName ──────────────────────────────────────────────────────────

describe("skillFolderName", () => {
  const hash8 = (lineage: string) => createHash("sha256").update(lineage).digest("hex").slice(0, 8);

  it("writes a lineage's dots as hyphens", () => {
    expect(skillFolderName("a-intel.brand.voice")).toBe("a-intel-brand-voice");
  });

  it("lowercases the lineage and replaces every character a harness refuses", () => {
    expect(skillFolderName("A-Intel.Brand_Voice")).toBe("a-intel-brand-voice");
  });

  it("keeps a name of exactly SKILL_NAME_MAX characters whole", () => {
    const lineage = `a.${"b".repeat(SKILL_NAME_MAX - 2)}`;
    expect(skillFolderName(lineage)).toBe(`a-${"b".repeat(SKILL_NAME_MAX - 2)}`);
    expect(skillFolderName(lineage)).toHaveLength(SKILL_NAME_MAX);
  });

  it("keeps the first 55 characters of a longer name and ends it with the lineage's hash", () => {
    const lineage = `a-intel.${"x".repeat(60)}`;
    const name = skillFolderName(lineage);
    expect(name).toBe(`a-intel-${"x".repeat(47)}-${hash8(lineage)}`);
    expect(name).toHaveLength(SKILL_NAME_MAX);
    expect(name).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(skillFolderName(lineage)).toBe(name);
  });

  it("gives two long lineages with the same first 55 characters different names", () => {
    const one = skillFolderName(`a-intel.${"x".repeat(60)}.one`);
    const two = skillFolderName(`a-intel.${"x".repeat(60)}.two`);
    expect(one.slice(0, 55)).toBe(two.slice(0, 55));
    expect(one).not.toBe(two);
    expect(one).toHaveLength(SKILL_NAME_MAX);
    expect(two).toHaveLength(SKILL_NAME_MAX);
  });

  it("ends a short name with the lineage's hash when asked for the digest", () => {
    expect(skillFolderName("a-intel.brand-voice", { digest: true })).toBe(
      `a-intel-brand-voice-${hash8("a-intel.brand-voice")}`,
    );
    expect(skillFolderName("a-intel.brand.voice", { digest: true })).toBe(
      `a-intel-brand-voice-${hash8("a-intel.brand.voice")}`,
    );
  });

  it("keeps a long name's hash once when asked for the digest", () => {
    const lineage = `a-intel.${"x".repeat(60)}`;
    expect(skillFolderName(lineage, { digest: true })).toBe(skillFolderName(lineage));
  });

  it("drops a hyphen the cut leaves at the end, so the name never holds two in a row", () => {
    // Character 55 of the name is the hyphen that stood for the dot.
    const lineage = `${"a".repeat(54)}.${"b".repeat(20)}`;
    const name = skillFolderName(lineage);
    expect(name).toBe(`${"a".repeat(54)}-${hash8(lineage)}`);
    expect(name).toHaveLength(SKILL_NAME_MAX - 1);
    expect(name).not.toContain("--");
  });

  it("gives every lineage a name the collector accepts as a skill folder", () => {
    const lineages = [
      "a-intel.brand.voice",
      "A-Intel.Brand_Voice",
      `a-intel.${"x".repeat(60)}`,
      `${"a".repeat(54)}.${"b".repeat(20)}`,
      "a-intel.ünïcode.skill",
    ];
    for (const lineage of lineages) {
      expect(skillFolderName(lineage)).toMatch(SKILL_NAME_PATTERN);
      expect(skillFolderName(lineage, { digest: true })).toMatch(SKILL_NAME_PATTERN);
    }
  });
});

// ── skillMarkdown ────────────────────────────────────────────────────────────

describe("skillMarkdown", () => {
  it("writes a description the record parser reads back unchanged, whatever it holds", () => {
    const description = 'Say "refund": never # not a comment\nA second line with a \\ backslash.';
    const split = splitRecordFile(skillMarkdown({ name: "voice", description, body: "Body\n" }));
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.parts.body).toBe("\nBody\n");
    const parsed = parseFrontmatter(split.parts.frontmatter);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontmatter.value).toEqual({ name: "voice", description });
  });
});

// ── runSkills ────────────────────────────────────────────────────────────────

describe("runSkills", () => {
  const VOICE = "steering/skills/a-intel.brand.voice/";
  const HOUSE_UI = "steering/skills/a-intel.design.house-ui/";
  const MIGRATION = "steering/skills/a-intel.platform.write-migration/";
  const REPORT = "steering/skills/a-intel.security.report-leak/";

  const WORKSPACE_IDENTITY: BundleIdentity = {
    repository: "github.com/a-intel/oxagen-core-platform",
    scope: "workspace",
    organization: "a-intel",
    workspace: "core-platform",
  };
  const ORGANIZATION_IDENTITY: BundleIdentity = {
    repository: "github.com/a-intel/oxagen",
    scope: "organization",
    organization: "a-intel",
  };

  const notBuilt: ToolCompiler = () => {
    throw new NotBuiltError("compile");
  };

  // The organization fixture holds no skill. These give it one of the same
  // lineage as a workspace skill, and one of its own.
  const ORG_VOICE = [
    "---",
    "schema: steering-record/v1",
    "lineage: a-intel.brand.voice",
    "label: Organization voice",
    "kind: skill",
    "name: voice",
    "description: Write in the organization voice.",
    "force: may",
    "scope: organization",
    "status: active",
    "origin: user",
    "provenance:",
    "  source: proposal",
    "  uri: oxagen:proposal/prp_01K5Z1AA",
    "---",
    "",
    "# Organization voice",
    "",
    "Write the way every a-intel team writes.",
    "",
  ].join("\n");
  const ORG_REPORT = [
    "---",
    "schema: steering-record/v1",
    "lineage: a-intel.security.report-leak",
    "label: Report a leak",
    "kind: skill",
    "name: report-leak",
    "description: Report a leaked credential to the security team.",
    "force: may",
    "scope: organization",
    "status: active",
    "origin: user",
    "provenance:",
    "  source: proposal",
    "  uri: oxagen:proposal/prp_01K5Z1AB",
    "---",
    "",
    "# Report a leak",
    "",
    "Rotate the credential first, then open an incident.",
    "",
  ].join("\n");

  function organizationFiles(): Map<string, string> {
    const files = organizationFixtureRepo();
    files.set(`${VOICE}SKILL.md`, ORG_VOICE);
    files.set(`${VOICE}words.md`, "# Organization words\n");
    files.set(`${REPORT}SKILL.md`, ORG_REPORT);
    return files;
  }

  async function build(
    identity: BundleIdentity,
    version: number,
    commit: string,
    published_at: string,
    files: ReadonlyMap<string, string>,
  ): Promise<Bundle> {
    const { bundle } = await buildBundle({
      identity,
      version,
      commit,
      published_at,
      reader: await TreeReader.open(treeFromFiles(files)),
      previous: null,
      compiler: notBuilt,
    });
    return bundle;
  }

  interface Fixtures {
    workspace: Bundle;
    organization: Bundle;
    workspaceFiles: ReadonlyMap<string, string>;
    organizationFiles: ReadonlyMap<string, string>;
  }

  // Built once for the describe. No test changes these bundles; a test that
  // needs a different one spreads a copy.
  let built: Promise<Fixtures> | undefined;
  function fixtures(): Promise<Fixtures> {
    built ??= (async () => {
      const workspaceFiles = fixtureRepo();
      const orgFiles = organizationFiles();
      const [workspace, organization] = await Promise.all([
        build(
          WORKSPACE_IDENTITY,
          21,
          "b5518188b20ddf02f905fadeaa50d9976abdcc90",
          "2026-09-24T10:00:30Z",
          workspaceFiles,
        ),
        build(
          ORGANIZATION_IDENTITY,
          4,
          "4f0c1d2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9",
          "2026-09-24T09:00:00Z",
          orgFiles,
        ),
      ]);
      return { workspace, organization, workspaceFiles, organizationFiles: orgFiles };
    })();
    return built;
  }

  interface AssetCall {
    source: BundleSource;
    version: number;
    path: string;
    blob: string;
  }

  /** Reads each file from the fixture it was built from, and records the call. */
  function assetReader(
    files: Partial<Record<BundleSource, ReadonlyMap<string, string>>>,
    calls: AssetCall[] = [],
  ): ReadAsset {
    return (source, bundle, file) => {
      calls.push({ source, version: bundle.version, path: file.path, blob: file.blob });
      const text = files[source]?.get(file.path);
      return text === undefined
        ? Promise.reject(new Error(`the ${source} fixture has no ${file.path}`))
        : Promise.resolve(text);
    };
  }

  function fileText(files: ReadonlyMap<string, string>, path: string): string {
    const text = files.get(path);
    if (text === undefined) throw new Error(`the fixture has no ${path}`);
    return text;
  }

  /** A record file's body: everything after the closing frontmatter fence. */
  function recordBody(text: string): string {
    return text.slice(text.indexOf("\n---\n") + "\n---\n".length);
  }

  it("gives a run on a repository every workspace skill whose repos is unset or names it", async () => {
    const { workspace, workspaceFiles: files } = await fixtures();
    const skills = await runSkills(
      { workspace, organization: null },
      "github.com/a-intel/platform",
      assetReader({ workspace: files }),
    );
    expect(skills).toEqual([
      {
        lineage: "a-intel.brand.voice",
        name: "a-intel-brand-voice",
        description:
          "Write customer-facing copy in the a-intel voice, with the words it uses and the ones it avoids.",
        body: recordBody(fileText(files, `${VOICE}SKILL.md`)),
        files: [
          { path: "assets/logo.svg", content: fileText(files, `${VOICE}assets/logo.svg`) },
          { path: "words.md", content: fileText(files, `${VOICE}words.md`) },
        ],
        source: "workspace",
        version: 21,
      },
      {
        lineage: "a-intel.design.house-ui",
        name: "a-intel-design-house-ui",
        description: "Build or change UI in a-intel apps with the house tokens and components.",
        body: recordBody(fileText(files, `${HOUSE_UI}SKILL.md`)),
        files: [
          { path: "components/button.md", content: fileText(files, `${HOUSE_UI}components/button.md`) },
          { path: "tokens.json", content: fileText(files, `${HOUSE_UI}tokens.json`) },
        ],
        source: "workspace",
        version: 21,
      },
      {
        lineage: "a-intel.platform.write-migration",
        name: "a-intel-platform-write-migration",
        description: "Write and check an Atlas migration for a schema change in packages/database.",
        body: recordBody(fileText(files, `${MIGRATION}SKILL.md`)),
        files: [{ path: "template.sql", content: fileText(files, `${MIGRATION}template.sql`) }],
        source: "workspace",
        version: 21,
      },
    ]);
    expect(skills[0]?.body).toContain("# Brand voice");
  });

  it("gives two skills whose lineages make one folder name a name each that ends with its lineage's hash", async () => {
    const { workspace, workspaceFiles: files } = await fixtures();
    const voice = workspace.records.find((record) => record.lineage === "a-intel.brand.voice");
    if (voice === undefined) throw new Error("The fixture has no a-intel.brand.voice skill.");
    const twin = { ...voice, lineage: "a-intel.brand-voice" };
    const skills = await runSkills(
      { workspace: { ...workspace, records: [...workspace.records, twin] }, organization: null },
      "github.com/a-intel/platform",
      assetReader({ workspace: files }),
    );
    const names = new Map(skills.map((entry) => [entry.lineage, entry.name]));
    expect(names.get("a-intel.brand.voice")).toBe(
      skillFolderName("a-intel.brand.voice", { digest: true }),
    );
    expect(names.get("a-intel.brand-voice")).toBe(
      skillFolderName("a-intel.brand-voice", { digest: true }),
    );
    expect(names.get("a-intel.brand.voice")).not.toBe(names.get("a-intel.brand-voice"));
    // A skill whose name no other skill shares keeps the plain name.
    expect(names.get("a-intel.design.house-ui")).toBe("a-intel-design-house-ui");
    expect(new Set(skills.map((entry) => entry.name)).size).toBe(skills.length);
  });

  it("leaves out a skill whose repos names another repository, and every such skill on a run with no repository", async () => {
    const { workspace, workspaceFiles: files } = await fixtures();
    for (const repository of ["github.com/a-intel/billing-service", null]) {
      const calls: AssetCall[] = [];
      const skills = await runSkills(
        { workspace, organization: null },
        repository,
        assetReader({ workspace: files }, calls),
      );
      expect(skills.map((entry) => entry.lineage)).toEqual([
        "a-intel.brand.voice",
        "a-intel.design.house-ui",
      ]);
      expect(calls.filter((call) => call.path.startsWith(MIGRATION))).toEqual([]);
    }
  });

  it("reads each file by the blob the published version recorded for it", async () => {
    const { workspace, workspaceFiles: files } = await fixtures();
    const calls: AssetCall[] = [];
    await runSkills({ workspace, organization: null }, null, assetReader({ workspace: files }, calls));
    expect(calls.map((call) => call.path)).toEqual([
      `${VOICE}SKILL.md`,
      `${VOICE}assets/logo.svg`,
      `${VOICE}words.md`,
      `${HOUSE_UI}SKILL.md`,
      `${HOUSE_UI}components/button.md`,
      `${HOUSE_UI}tokens.json`,
    ]);
    for (const call of calls) {
      expect(call).toEqual({
        source: "workspace",
        version: 21,
        path: call.path,
        blob: gitBlobId(fileText(files, call.path)),
      });
    }
  });

  it("returns no skills when neither version is published", async () => {
    const calls: AssetCall[] = [];
    expect(
      await runSkills({ workspace: null, organization: null }, null, assetReader({}, calls)),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("gives a run the organization's skills when the workspace has no version", async () => {
    const { organization, organizationFiles: files } = await fixtures();
    const skills = await runSkills(
      { workspace: null, organization },
      null,
      assetReader({ organization: files }),
    );
    expect(skills).toEqual([
      {
        lineage: "a-intel.brand.voice",
        name: "a-intel-brand-voice",
        description: "Write in the organization voice.",
        body: "\n# Organization voice\n\nWrite the way every a-intel team writes.\n",
        files: [{ path: "words.md", content: "# Organization words\n" }],
        source: "organization",
        version: 4,
      },
      {
        lineage: "a-intel.security.report-leak",
        name: "a-intel-security-report-leak",
        description: "Report a leaked credential to the security team.",
        body: "\n# Report a leak\n\nRotate the credential first, then open an incident.\n",
        files: [],
        source: "organization",
        version: 4,
      },
    ]);
  });

  it("gives the workspace's skill over an organization skill of the same lineage", async () => {
    const { workspace, organization, workspaceFiles, organizationFiles: orgFiles } = await fixtures();
    const calls: AssetCall[] = [];
    const skills = await runSkills(
      { workspace, organization },
      null,
      assetReader({ workspace: workspaceFiles, organization: orgFiles }, calls),
    );
    expect(skills.map((entry) => [entry.lineage, entry.source, entry.version])).toEqual([
      ["a-intel.brand.voice", "workspace", 21],
      ["a-intel.design.house-ui", "workspace", 21],
      ["a-intel.security.report-leak", "organization", 4],
    ]);
    expect(skills[0]).toMatchObject({
      description:
        "Write customer-facing copy in the a-intel voice, with the words it uses and the ones it avoids.",
      body: recordBody(fileText(workspaceFiles, `${VOICE}SKILL.md`)),
      files: [
        { path: "assets/logo.svg", content: fileText(workspaceFiles, `${VOICE}assets/logo.svg`) },
        { path: "words.md", content: fileText(workspaceFiles, `${VOICE}words.md`) },
      ],
    });
    // The organization's version of the skill is never read.
    expect(
      calls.filter((call) => call.source === "organization").map((call) => [call.path, call.version]),
    ).toEqual([[`${REPORT}SKILL.md`, 4]]);
  });

  it("reads a skill whose files arrive as bytes the same as one whose files arrive as text", async () => {
    const { workspace, workspaceFiles: files } = await fixtures();
    const encoder = new TextEncoder();
    const asText = assetReader({ workspace: files });
    const asBytes: ReadAsset = async (source, bundle, file) => {
      const content = await asText(source, bundle, file);
      return typeof content === "string" ? encoder.encode(content) : content;
    };
    const delivery = { workspace, organization: null };
    const fromText = await runSkills(delivery, null, asText);
    const fromBytes = await runSkills(delivery, null, asBytes);
    expect(fromBytes.map((entry) => entry.body)).toEqual(fromText.map((entry) => entry.body));
    expect(fromBytes[0]?.files).toEqual(
      fromText[0]?.files.map((file) => ({
        path: file.path,
        content: typeof file.content === "string" ? encoder.encode(file.content) : file.content,
      })),
    );
    expect(fromBytes.map(skillDigest)).toEqual(fromText.map(skillDigest));
  });

  it("takes the label when a skill has no description, no files when it lists none, and only files in its own folder", async () => {
    const { workspace, workspaceFiles: files } = await fixtures();
    const patched: Bundle = {
      ...workspace,
      records: workspace.records.map((record) => {
        if (record.lineage === "a-intel.brand.voice") {
          return {
            ...record,
            files: [
              // A sibling folder whose name starts with this one's.
              { path: "steering/skills/a-intel.brand.voice-old/words.md", blob: "0".repeat(40) },
              ...[...(record.files ?? [])].reverse(),
            ],
          };
        }
        if (record.lineage === "a-intel.design.house-ui") {
          return { ...record, description: undefined, files: undefined };
        }
        return record;
      }),
    };
    const calls: AssetCall[] = [];
    const [voice, houseUi] = await runSkills(
      { workspace: patched, organization: null },
      null,
      assetReader({ workspace: files }, calls),
    );
    expect(voice?.files.map((file) => file.path)).toEqual(["assets/logo.svg", "words.md"]);
    expect(houseUi?.description).toBe("House UI");
    expect(houseUi?.files).toEqual([]);
    expect(calls.map((call) => call.path)).toEqual([
      `${VOICE}SKILL.md`,
      `${VOICE}words.md`,
      `${VOICE}assets/logo.svg`,
      `${HOUSE_UI}SKILL.md`,
    ]);
  });

  it("renders a body's tool mentions for the modes of the version that holds the skill", async () => {
    const { workspace, workspaceFiles } = await fixtures();
    const files = new Map(workspaceFiles);
    files.set(
      `${VOICE}SKILL.md`,
      `${fileText(workspaceFiles, `${VOICE}SKILL.md`)}Refund with @tool:billing__create_refund when asked.\n`,
    );
    const searched: Bundle = {
      ...workspace,
      tools: {
        schema: "tool-manifest/v1",
        servers: [{ name: "billing", exposure: { mode: "search" } }],
      },
    };
    const [voice] = await runSkills(
      { workspace: searched, organization: null },
      null,
      assetReader({ workspace: files }),
    );
    expect(voice?.body).toContain("Refund with call billing__call with tool create_refund when asked.");
    expect(voice?.body).not.toContain("@tool:");
  });

  it("throws RecordFileError when a skill's SKILL.md does not read as a record", async () => {
    const { workspace, workspaceFiles: files } = await fixtures();
    const fromFixture = assetReader({ workspace: files });
    const broken: ReadAsset = (source, bundle, file) =>
      file.path.endsWith("/SKILL.md")
        ? Promise.resolve("This file lost its frontmatter.\n")
        : fromFixture(source, bundle, file);
    const run = runSkills({ workspace, organization: null }, null, broken);
    await expect(run).rejects.toBeInstanceOf(RecordFileError);
    await expect(run).rejects.toThrow(
      `${VOICE}SKILL.md is not a steering record file, so its body cannot be read.`,
    );
  });
});
