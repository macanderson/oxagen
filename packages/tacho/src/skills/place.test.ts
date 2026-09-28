// place.test.ts: how session start places a run's skills under a harness's
// skills folder, and how session end removes them.
//
// Each placeSkills and removeSkills test writes to a fresh temp folder and
// passes `now` on every call, so no test reads the clock unless it says so.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tachoHarnessSchema, type TachoHarness } from "../wire";
import {
  placeSkills,
  removeSkills,
  SESSION_MARKER,
  SESSION_TTL_MS,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
  skillDigest,
  skillFileRefusal,
  skillMarkdown,
  skillsRoot,
  type SessionSkill,
} from "./place";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const T0 = new Date("2026-09-26T12:00:00.000Z");

/** A time `ms` milliseconds after T0. */
function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

const VOICE_NAME = "a-intel-brand-voice";

/** A skill as the server sends it. Each test changes only what it is about. */
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

  it("returns a folder under the home folder for each harness that reads user skills", () => {
    expect(tachoHarnessSchema.options.map((harness) => [harness, skillsRoot(harness, {}, HOME)])).toEqual([
      ["claude-code", join(HOME, ".claude", "skills")],
      ["codex", join(HOME, ".agents", "skills")],
      ["cursor", null],
      ["stella", join(HOME, ".stella", "skills")],
      ["claude-desktop", null],
    ]);
  });

  interface RootCase {
    harness: TachoHarness;
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

  it.each(["cursor", "claude-desktop"] as const)(
    "returns null for %s whatever the environment says",
    (harness) => {
      expect(
        skillsRoot(
          harness,
          { CLAUDE_CONFIG_DIR: "/a", CODEX_HOME: "/b", STELLA_HOME: "/c", CURSOR_HOME: "/d" },
          HOME,
        ),
      ).toBeNull();
    },
  );

  it("reads the process environment and the user's home folder when none is given", () => {
    vi.stubEnv("STELLA_HOME", "/stubbed/stella");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    expect(skillsRoot("stella")).toBe(join("/stubbed/stella", "skills"));
    expect(skillsRoot("claude-code")).toBe(join(homedir(), ".claude", "skills"));
    expect(skillsRoot("codex", {})).toBe(join(homedir(), ".agents", "skills"));
  });
});

// ── skill names and file paths ───────────────────────────────────────────────

describe("SKILL_NAME_PATTERN", () => {
  it.each(["a", "a-intel-brand-voice", "0-9", "x".repeat(SKILL_NAME_MAX)])("accepts %s", (name) => {
    expect(SKILL_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each(["", "A-Intel", "a.b", "a/b", "..", "a_b", "x".repeat(SKILL_NAME_MAX + 1)])(
    "refuses %j",
    (name) => {
      expect(SKILL_NAME_PATTERN.test(name)).toBe(false);
    },
  );
});

describe("skillFileRefusal", () => {
  it.each(["words.md", "assets/logo.svg", "a/b/c.txt", ".hidden", "SKILL.md.bak", "assets/SKILL.md"])(
    "accepts %s",
    (path) => {
      expect(skillFileRefusal(path)).toBeNull();
    },
  );

  it.each([
    "",
    "/etc/passwd",
    "../escape.md",
    "assets/../../escape.md",
    "./words.md",
    "assets//logo.svg",
    "assets/",
    "assets\\logo.svg",
    "words\0.md",
  ])("refuses %j as not a relative path", (path) => {
    expect(skillFileRefusal(path)).toBe("is not a relative path");
  });

  it.each(["SKILL.md", SESSION_MARKER])("refuses %s, which session start writes itself", (path) => {
    expect(skillFileRefusal(path)).toBe("is a file session start writes");
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

// ── placeSkills and removeSkills ─────────────────────────────────────────────

describe("placeSkills", () => {
  let tmp = "";
  let root = "";
  let folder = "";

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "tacho-skills-"));
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

  it("keeps the version another live session placed, joins its marker, and warns", async () => {
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
      sessions: { s1: T0.toISOString(), s2: at(60_000).toISOString() },
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
    const hyphenated = skill({ lineage: "a-intel.brand-voice", body: "# Hyphenated\n" });
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

  it.each(["../escape", "A-Voice", "a.voice", "", "x".repeat(SKILL_NAME_MAX + 1)])(
    "refuses a skill whose folder name %j is not a skill name, and writes nothing for it",
    async (name) => {
      const result = await placeSkills(root, "s1", [skill({ name })], T0);
      expect(result).toEqual({
        placed: [],
        skipped: [name],
        warnings: [
          `a-intel.brand.voice was not placed, because its folder name ${JSON.stringify(name)} is not a skill name.`,
        ],
      });
      expect(await readdir(root)).toEqual([]);
      expect(await readdir(tmp)).toEqual(["home"]);
    },
  );

  it("refuses a skill with a file that would land outside its folder, and still places the rest", async () => {
    const other = skill({ lineage: "a-intel.other", name: "a-other" });
    const escaping = skill({ files: [{ path: "../../escape.md", content: "Out.\n" }] });
    const result = await placeSkills(root, "s1", [escaping, other], T0);
    expect(result).toEqual({
      placed: ["a-other"],
      skipped: [VOICE_NAME],
      warnings: [
        'a-intel.brand.voice was not placed, because its file "../../escape.md" is not a relative path.',
      ],
    });
    expect(await readdir(root)).toEqual(["a-other"]);
    expect((await readdir(join(tmp, "home"))).sort()).toEqual([".claude"]);
  });

  it("refuses a skill whose file would replace its own SKILL.md or marker", async () => {
    const result = await placeSkills(
      root,
      "s1",
      [skill({ files: [{ path: SESSION_MARKER, content: "{}" }] })],
      T0,
    );
    expect(result.warnings).toEqual([
      `a-intel.brand.voice was not placed, because its file ${JSON.stringify(SESSION_MARKER)} is a file session start writes.`,
    ]);
    expect(await readdir(root)).toEqual([]);
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
    tmp = await mkdtemp(join(tmpdir(), "tacho-skills-"));
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

  it("keeps a kept folder when the session that placed it ends, until the session that joined it ends too", async () => {
    // The kept-version warning tells s2 it reads s1's version until it ends,
    // so s2 holds the folder too. s1's end must not delete it under s2.
    const folder = join(root, VOICE_NAME);
    const first = skill();
    await placeSkills(root, "s1", [first], T0);
    const skipped = await placeSkills(
      root,
      "s2",
      [skill({ body: "# Brand voice\n\nA newer version.\n" })],
      at(1_000),
    );
    expect(skipped.warnings).toEqual([keptWarning(folder)]);

    expect(await removeSkills(root, "s1", at(2_000))).toEqual({ removed: [], kept: [VOICE_NAME] });
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(skillMarkdown(first));
    expect(await markerIn(folder)).toEqual({
      digest: skillDigest(first),
      sessions: { s2: at(1_000).toISOString() },
    });

    expect(await removeSkills(root, "s2", at(3_000))).toEqual({ removed: [VOICE_NAME], kept: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves a folder alone when this session never held it and another live session does", async () => {
    await placeSkills(root, "s1", [skill()], T0);
    expect(await removeSkills(root, "s2", at(1_000))).toEqual({ removed: [], kept: [] });
    expect(await markerIn(join(root, VOICE_NAME))).toEqual({
      digest: skillDigest(skill()),
      sessions: { s1: T0.toISOString() },
    });
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
