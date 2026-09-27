// session.test.ts: which skills reach a run, and how session start and end
// place and remove them under a harness's skills folder.
//
// The runSkills tests build real published versions from the fixture repos,
// with a compiler that throws NotBuiltError, so no MCP Studio code runs. The
// placeSkills and removeSkills tests write to a fresh temp folder and pass
// `now` on every call, so no test reads the clock unless it says so.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotBuiltError } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import {
  fixtureRepo,
  organizationFixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { parseFrontmatter, splitRecordFile } from "@oxagen/oxagen/steering-repo/record";
import { buildBundle, type BundleIdentity } from "./build";
import { RecordFileError } from "./read";
import type { BundleSource } from "./render";
import {
  HARNESSES,
  placeSkills,
  removeSkills,
  runSkills,
  SESSION_MARKER,
  SESSION_TTL_MS,
  SKILL_NAME_MAX,
  skillDigest,
  skillFolderName,
  skillMarkdown,
  skillsRoot,
  type Harness,
  type ReadAsset,
  type SessionSkill,
} from "./session";
import type { ToolCompiler } from "./tools";
import { gitBlobId, TreeReader, treeFromFiles } from "./tree";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const T0 = new Date("2026-09-26T12:00:00.000Z");

/** A time `ms` milliseconds after T0. */
function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

const VOICE_NAME = "a-intel-brand-voice";

/** A skill as runSkills returns it. Each test changes only what it is about. */
function skill(overrides: Partial<SessionSkill> = {}): SessionSkill {
  return {
    lineage: "a-intel.brand.voice",
    name: VOICE_NAME,
    description: "Write in the a-intel voice.",
    body: "# Brand voice\n\nState the fact.\n",
    files: [{ path: "words.md", content: "# Words\n" }],
    source: "workspace",
    version: 21,
    ...overrides,
  };
}

function foreignWarning(folder: string, lineage = "a-intel.brand.voice"): string {
  return `${folder} holds a skill Oxagen did not write, so ${lineage} was not placed. Rename that folder to receive it.`;
}

function keptWarning(folder: string, lineage = "a-intel.brand.voice"): string {
  return `${lineage} kept the version another running session placed in ${folder}. This session reads that version until it ends.`;
}

async function markerIn(folder: string): Promise<unknown> {
  return JSON.parse(await readFile(join(folder, SESSION_MARKER), "utf8")) as unknown;
}

// ── skillsRoot ───────────────────────────────────────────────────────────────

describe("skillsRoot", () => {
  const HOME = join("/home", "dev");

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the four harnesses", () => {
    expect(HARNESSES).toEqual(["claude-code", "codex", "cursor", "stella"]);
  });

  it("returns a folder under the home folder for every harness but Cursor", () => {
    expect(HARNESSES.map((harness) => [harness, skillsRoot(harness, {}, HOME)])).toEqual([
      ["claude-code", join(HOME, ".claude", "skills")],
      ["codex", join(HOME, ".agents", "skills")],
      ["cursor", null],
      ["stella", join(HOME, ".stella", "skills")],
    ]);
  });

  interface RootCase {
    harness: Harness;
    env: Record<string, string>;
    expected: string;
  }
  const ROOT_CASES: RootCase[] = [
    {
      harness: "claude-code",
      env: { CLAUDE_CONFIG_DIR: "/cfg/claude" },
      expected: join("/cfg/claude", "skills"),
    },
    { harness: "claude-code", env: { CLAUDE_CONFIG_DIR: "" }, expected: join(HOME, ".claude", "skills") },
    { harness: "claude-code", env: { CLAUDE_CONFIG_DIR: "   " }, expected: join(HOME, ".claude", "skills") },
    {
      harness: "claude-code",
      env: { CODEX_HOME: "/cfg/codex", STELLA_HOME: "/cfg/stella" },
      expected: join(HOME, ".claude", "skills"),
    },
    { harness: "codex", env: { CODEX_HOME: "/cfg/codex" }, expected: join("/cfg/codex", "skills") },
    { harness: "codex", env: { CODEX_HOME: " " }, expected: join(HOME, ".agents", "skills") },
    {
      harness: "codex",
      env: { CLAUDE_CONFIG_DIR: "/cfg/claude" },
      expected: join(HOME, ".agents", "skills"),
    },
    { harness: "stella", env: { STELLA_HOME: "/cfg/stella" }, expected: join("/cfg/stella", "skills") },
    { harness: "stella", env: { STELLA_HOME: "" }, expected: join(HOME, ".stella", "skills") },
    {
      harness: "stella",
      env: { CODEX_HOME: "/cfg/codex" },
      expected: join(HOME, ".stella", "skills"),
    },
  ];

  it.each(ROOT_CASES)("reads $harness skills from $expected with env $env", ({ harness, env, expected }) => {
    expect(skillsRoot(harness, env, HOME)).toBe(expected);
  });

  it("returns null for Cursor whatever the environment says", () => {
    expect(
      skillsRoot(
        "cursor",
        { CLAUDE_CONFIG_DIR: "/a", CODEX_HOME: "/b", STELLA_HOME: "/c", CURSOR_HOME: "/d" },
        HOME,
      ),
    ).toBeNull();
  });

  it("reads the process environment and the user's home folder when none is given", () => {
    vi.stubEnv("STELLA_HOME", "/stubbed/stella");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    expect(skillsRoot("stella")).toBe(join("/stubbed/stella", "skills"));
    expect(skillsRoot("claude-code")).toBe(join(homedir(), ".claude", "skills"));
    expect(skillsRoot("codex", {})).toBe(join(homedir(), ".agents", "skills"));
  });
});

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
});

// ── skillMarkdown and skillDigest ────────────────────────────────────────────

describe("skillMarkdown", () => {
  it("writes the name and the quoted description as frontmatter, then the body", () => {
    expect(
      skillMarkdown({
        name: "a-intel-brand-voice",
        description: "Write in the a-intel voice.",
        body: "# Brand voice\n\nState the fact.\n",
      }),
    ).toBe(
      '---\nname: a-intel-brand-voice\ndescription: "Write in the a-intel voice."\n---\n\n# Brand voice\n\nState the fact.\n',
    );
  });

  it("drops the blank lines a body starts with and keeps the ones it ends with", () => {
    expect(skillMarkdown({ name: "n", description: "d", body: "\n\n# Title\n\nText\n\n" })).toBe(
      '---\nname: n\ndescription: "d"\n---\n\n# Title\n\nText\n\n',
    );
  });

  it("writes a description YAML reads back unchanged, whatever it holds", () => {
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

describe("skillDigest", () => {
  it("is sha256 over SKILL.md for a skill with no other files", () => {
    const bare = skill({ files: [] });
    expect(skillDigest(bare)).toBe(
      `sha256:${createHash("sha256").update(skillMarkdown(bare)).digest("hex")}`,
    );
  });

  it("holds when nothing session start writes changes", () => {
    expect(skillDigest(skill())).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(skillDigest(skill())).toBe(skillDigest(skill()));
    expect(skillDigest(skill({ version: 22, source: "organization" }))).toBe(skillDigest(skill()));
  });

  it("reads a file given as text and the same file given as bytes the same way", () => {
    const asBytes = skill({
      files: [{ path: "words.md", content: new TextEncoder().encode("# Words\n") }],
    });
    expect(skillDigest(asBytes)).toBe(skillDigest(skill()));
  });

  const CHANGES: Array<[string, Partial<SessionSkill>]> = [
    ["the name", { name: "a-intel-voice" }],
    ["the description", { description: "Write in another voice." }],
    ["the body", { body: "# Brand voice\n\nA newer version.\n" }],
    ["a file's content", { files: [{ path: "words.md", content: "# Other words\n" }] }],
    ["a file's path", { files: [{ path: "vocabulary.md", content: "# Words\n" }] }],
    [
      "an added file",
      {
        files: [
          { path: "words.md", content: "# Words\n" },
          { path: "extra.md", content: "More.\n" },
        ],
      },
    ],
    ["a removed file", { files: [] }],
  ];

  it.each(CHANGES)("changes when %s changes", (_what, change) => {
    expect(skillDigest(skill(change))).not.toBe(skillDigest(skill()));
  });

  it("keeps a file's path apart from its content", () => {
    const one = skill({ files: [{ path: "ab", content: "c" }] });
    const two = skill({ files: [{ path: "a", content: "bc" }] });
    expect(skillDigest(one)).not.toBe(skillDigest(two));
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

// ── placeSkills and removeSkills ─────────────────────────────────────────────

describe("placeSkills", () => {
  let tmp = "";
  let root = "";
  let folder = "";

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "s5-session-"));
    // Left for placeSkills to create.
    root = join(tmp, "home", ".claude", "skills");
    folder = join(root, VOICE_NAME);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes the skill's files and a marker naming the session", async () => {
    const logo = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x00, 0xff]);
    const voice = skill({
      files: [
        { path: "assets/logo.svg", content: logo },
        { path: "words.md", content: "# Words\n" },
      ],
    });
    const result = await placeSkills(root, "s1", [voice], T0);
    expect(result).toEqual({ placed: [VOICE_NAME], skipped: [], warnings: [] });
    expect((await readdir(folder)).sort()).toEqual([SESSION_MARKER, "SKILL.md", "assets", "words.md"]);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(skillMarkdown(voice));
    expect(await readFile(join(folder, "words.md"), "utf8")).toBe("# Words\n");
    expect(new Uint8Array(await readFile(join(folder, "assets", "logo.svg")))).toEqual(logo);
    const marker = await readFile(join(folder, SESSION_MARKER), "utf8");
    expect(JSON.parse(marker)).toEqual({
      digest: skillDigest(voice),
      sessions: { s1: "2026-09-26T12:00:00.000Z" },
    });
    expect(marker.endsWith("}\n")).toBe(true);
  });

  it("leaves a folder with no marker alone and warns", async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), "Written by hand.\n");
    const result = await placeSkills(root, "s1", [skill()], T0);
    expect(result).toEqual({
      placed: [],
      skipped: [VOICE_NAME],
      warnings: [foreignWarning(folder)],
    });
    expect(await readdir(folder)).toEqual(["SKILL.md"]);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe("Written by hand.\n");
  });

  it("counts an empty folder as someone else's, since it has no marker", async () => {
    await mkdir(folder, { recursive: true });
    const result = await placeSkills(root, "s1", [skill()], T0);
    expect(result).toEqual({
      placed: [],
      skipped: [VOICE_NAME],
      warnings: [foreignWarning(folder)],
    });
    expect(await readdir(folder)).toEqual([]);
  });

  it("leaves a plain file where the skill folder would go alone and warns", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(folder, "A file, not a folder.\n");
    const result = await placeSkills(root, "s1", [skill()], T0);
    expect(result).toEqual({
      placed: [],
      skipped: [VOICE_NAME],
      warnings: [foreignWarning(folder)],
    });
    expect(await readFile(folder, "utf8")).toBe("A file, not a folder.\n");
  });

  const FOREIGN_MARKERS: Array<[string, string]> = [
    ["text that is not JSON", "not json\n"],
    ["null", "null\n"],
    ["a number", "42\n"],
    ["an object with no digest", '{"sessions":{}}\n'],
    ["sessions that are null", '{"digest":"sha256:0","sessions":null}\n'],
    ["sessions that are a string", '{"digest":"sha256:0","sessions":"s1"}\n'],
    ["a session time that is not a string", '{"digest":"sha256:0","sessions":{"s1":1}}\n'],
  ];

  it.each(FOREIGN_MARKERS)("treats a marker holding %s as foreign", async (_what, text) => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, SESSION_MARKER), text);
    const result = await placeSkills(root, "s1", [skill()], T0);
    expect(result).toEqual({
      placed: [],
      skipped: [VOICE_NAME],
      warnings: [foreignWarning(folder)],
    });
    expect(await readFile(join(folder, SESSION_MARKER), "utf8")).toBe(text);
  });

  it("stops when it cannot read the folder for a reason other than a missing folder or a file", async () => {
    await mkdir(root, { recursive: true });
    // A link to itself: reading it fails with ELOOP.
    await symlink(VOICE_NAME, folder);
    await expect(placeSkills(root, "s1", [skill()], T0)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("joins a folder that holds the same version without rewriting it", async () => {
    const voice = skill();
    await placeSkills(root, "s1", [voice], T0);
    // A rewrite would delete this file.
    await writeFile(join(folder, "notes.txt"), "Still here.\n");
    const result = await placeSkills(root, "s2", [voice], at(60_000));
    expect(result).toEqual({ placed: [VOICE_NAME], skipped: [], warnings: [] });
    expect(await readFile(join(folder, "notes.txt"), "utf8")).toBe("Still here.\n");
    expect(await markerIn(folder)).toEqual({
      digest: skillDigest(voice),
      sessions: { s1: T0.toISOString(), s2: at(60_000).toISOString() },
    });
  });

  it("keeps the version another live session placed and warns", async () => {
    const first = skill();
    const second = skill({ body: "# Brand voice\n\nA newer version.\n" });
    await placeSkills(root, "s1", [first], T0);
    const result = await placeSkills(root, "s2", [second], at(60_000));
    expect(result).toEqual({
      placed: [],
      skipped: [VOICE_NAME],
      warnings: [keptWarning(folder)],
    });
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(skillMarkdown(first));
    expect(await markerIn(folder)).toEqual({
      digest: skillDigest(first),
      sessions: { s1: T0.toISOString() },
    });
  });

  it("rewrites the folder when the only session holding it is this one", async () => {
    const first = skill({ files: [{ path: "old.md", content: "Old.\n" }] });
    const second = skill({ body: "# Brand voice\n\nA newer version.\n", files: [{ path: "new.md", content: "New.\n" }] });
    await placeSkills(root, "s1", [first], T0);
    const result = await placeSkills(root, "s1", [second], at(1_000));
    expect(result).toEqual({ placed: [VOICE_NAME], skipped: [], warnings: [] });
    expect((await readdir(folder)).sort()).toEqual([SESSION_MARKER, "SKILL.md", "new.md"]);
    expect(await markerIn(folder)).toEqual({
      digest: skillDigest(second),
      sessions: { s1: at(1_000).toISOString() },
    });
  });

  it("counts a session live for SESSION_TTL_MS after it placed the skill, and expired from then on", async () => {
    expect(SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const first = skill({ files: [{ path: "old.md", content: "Old.\n" }] });
    const second = skill({ body: "# Brand voice\n\nA newer version.\n", files: [] });
    await placeSkills(root, "s1", [first], T0);

    const early = await placeSkills(root, "s2", [second], at(SESSION_TTL_MS - 1));
    expect(early.skipped).toEqual([VOICE_NAME]);

    const result = await placeSkills(root, "s2", [second], at(SESSION_TTL_MS));
    expect(result).toEqual({ placed: [VOICE_NAME], skipped: [], warnings: [] });
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(skillMarkdown(second));
    expect((await readdir(folder)).sort()).toEqual([SESSION_MARKER, "SKILL.md"]);
    expect(await markerIn(folder)).toEqual({
      digest: skillDigest(second),
      sessions: { s2: at(SESSION_TTL_MS).toISOString() },
    });
  });

  it("drops expired sessions from the marker when a session joins", async () => {
    const voice = skill();
    await placeSkills(root, "s1", [voice], T0);
    await placeSkills(root, "s2", [voice], at(SESSION_TTL_MS));
    expect(await markerIn(folder)).toEqual({
      digest: skillDigest(voice),
      sessions: { s2: at(SESSION_TTL_MS).toISOString() },
    });
  });

  it("counts a session whose time does not parse as expired", async () => {
    const first = skill();
    const second = skill({ body: "# Brand voice\n\nA newer version.\n" });
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), skillMarkdown(first));
    await writeFile(
      join(folder, SESSION_MARKER),
      JSON.stringify({ digest: skillDigest(first), sessions: { s1: "yesterday" } }),
    );
    const result = await placeSkills(root, "s2", [second], T0);
    expect(result).toEqual({ placed: [VOICE_NAME], skipped: [], warnings: [] });
    expect(await markerIn(folder)).toEqual({
      digest: skillDigest(second),
      sessions: { s2: T0.toISOString() },
    });
  });

  it("places the first of two skills that share a folder name and warns about the second", async () => {
    const dotted = skill({ lineage: "a-intel.brand.voice", body: "# Dotted\n" });
    const hyphenated = skill({
      lineage: "a-intel.brand-voice",
      name: skillFolderName("a-intel.brand-voice"),
      body: "# Hyphenated\n",
    });
    expect(hyphenated.name).toBe(dotted.name);
    const result = await placeSkills(root, "s1", [dotted, hyphenated], T0);
    expect(result).toEqual({
      placed: [VOICE_NAME],
      skipped: [VOICE_NAME],
      warnings: [
        `a-intel.brand-voice was not placed, because another skill of this session already uses ${folder}.`,
      ],
    });
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(skillMarkdown(dotted));
  });

  it("reads the clock when no time is given", async () => {
    const before = Date.now();
    const result = await placeSkills(root, "s1", [skill()]);
    const after = Date.now();
    expect(result.placed).toEqual([VOICE_NAME]);
    const marker = (await markerIn(folder)) as { sessions: Record<string, string> };
    const placedAt = Date.parse(marker.sessions["s1"] ?? "");
    expect(placedAt).toBeGreaterThanOrEqual(before);
    expect(placedAt).toBeLessThanOrEqual(after);
    expect(await removeSkills(root, "s1")).toEqual({ removed: [VOICE_NAME], kept: [] });
  });
});

describe("removeSkills", () => {
  let tmp = "";
  let root = "";

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "s5-session-"));
    root = join(tmp, "skills");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("removes this session's folders, keeps one another live session holds, and touches nothing else", async () => {
    const mine = skill({ lineage: "a-intel.mine", name: "a-mine" });
    const shared = skill({ lineage: "a-intel.shared", name: "b-shared" });
    const other = skill({ lineage: "a-intel.other", name: "c-other" });
    const crashed = skill({ lineage: "a-intel.crashed", name: "e-crashed" });
    await placeSkills(root, "s1", [mine, shared], T0);
    await placeSkills(root, "s2", [shared, other], at(1_000));
    // s3 crashed a day ago and never removed its skill.
    await placeSkills(root, "s3", [crashed], at(-SESSION_TTL_MS));
    await mkdir(join(root, "d-hand"));
    await writeFile(join(root, "d-hand", "SKILL.md"), "Written by hand.\n");
    await writeFile(join(root, "f-file.md"), "A file.\n");

    const result = await removeSkills(root, "s1", at(60_000));

    expect(result).toEqual({ removed: ["a-mine", "e-crashed"], kept: ["b-shared"] });
    expect((await readdir(root)).sort()).toEqual(["b-shared", "c-other", "d-hand", "f-file.md"]);
    expect(await markerIn(join(root, "b-shared"))).toEqual({
      digest: skillDigest(shared),
      sessions: { s2: at(1_000).toISOString() },
    });
    expect(await markerIn(join(root, "c-other"))).toEqual({
      digest: skillDigest(other),
      sessions: { s2: at(1_000).toISOString() },
    });
    expect(await readFile(join(root, "d-hand", "SKILL.md"), "utf8")).toBe("Written by hand.\n");
    expect(await readFile(join(root, "f-file.md"), "utf8")).toBe("A file.\n");
  });

  it("deletes a kept folder when the session that placed it ends, while the skipped session still runs", async () => {
    // Characterization of a defect. The kept-version warning tells s2 it
    // reads s1's version until it ends, but placeSkills never adds s2 to
    // the marker. So s1's session end deletes the folder under s2.
    const folder = join(root, VOICE_NAME);
    await placeSkills(root, "s1", [skill()], T0);
    const skipped = await placeSkills(
      root,
      "s2",
      [skill({ body: "# Brand voice\n\nA newer version.\n" })],
      at(1_000),
    );
    expect(skipped.warnings).toEqual([keptWarning(folder)]);
    expect(await removeSkills(root, "s1", at(2_000))).toEqual({ removed: [VOICE_NAME], kept: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it("returns empty lists for a root that does not exist", async () => {
    expect(await removeSkills(join(tmp, "missing"), "s1", T0)).toEqual({ removed: [], kept: [] });
  });

  it("throws when the root is a file", async () => {
    const file = join(tmp, "skills-file");
    await writeFile(file, "A file.\n");
    await expect(removeSkills(file, "s1", T0)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
