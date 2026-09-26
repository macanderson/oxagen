import { describe, expect, it } from "vitest";
import { readTomlFile, type FileIssue } from "./files";
import { fixtureRepo, organizationFixtureRepo } from "./fixture-repo";
import { governanceSchema } from "./governance";
import { REQUIRED_CHECK_NAME } from "./names";
import {
  AGENTS_MD_PATH,
  classifySteeringRepoPath,
  CLAUDE_MD_PATH,
  GITATTRIBUTES_PATH,
  GOVERNANCE_TOML_PATH,
  README_PATH,
  WORKSPACE_TOML_PATH,
  type SteeringRepoFileKind,
} from "./paths";
import { schemaDirective, schemaUrl } from "./schema-ids";
import {
  agentsMdTemplate,
  claudeMdTemplate,
  firstCommitFiles,
  gitattributesTemplate,
  governanceTomlTemplate,
  MANAGED_BLOCK_END,
  managedBlockHash,
  readManagedBlock,
  readmeTemplate,
  renderManagedBlock,
  workspaceTomlTemplate,
  type SteeringRepoTemplateInput,
} from "./templates";
import { workspaceSchema } from "./workspace";

// The inputs that produced the fixture repositories' first commits.
const workspaceInput: SteeringRepoTemplateInput = {
  provider: "github",
  organization: "a-intel",
  repository: "a-intel/oxagen-core-platform",
  scope: { kind: "workspace", slug: "core-platform", label: "Core platform" },
};
const organizationInput: SteeringRepoTemplateInput = {
  provider: "github",
  organization: "a-intel",
  repository: "a-intel/oxagen",
  scope: { kind: "organization" },
};

const PROVIDERS = ["github", "gitlab"] as const;
const SCOPES = [
  { name: "workspace", input: workspaceInput },
  { name: "organization", input: organizationInput },
] as const;

type ReadOutcome = { ok: true } | { ok: false; issues: readonly FileIssue[] };

function managedBlockOutcome(text: string): ReadOutcome {
  const read = readManagedBlock(text);
  return read.ok ? { ok: true } : { ok: false, issues: [read.issue] };
}

// The reader for each kind of file a first commit holds. .gitattributes has
// no format of its own, and the byte test below pins it.
const READERS: Partial<Record<SteeringRepoFileKind, (text: string) => ReadOutcome>> = {
  "agents-md": managedBlockOutcome,
  "claude-md": managedBlockOutcome,
  readme: managedBlockOutcome,
  workspace: (text) => readTomlFile(text, "workspace/v1", workspaceSchema),
  governance: (text) => readTomlFile(text, "governance/v1", governanceSchema),
};

const BEGIN = (hash: string) => `<!-- oxagen:begin managed sha256:${hash} -->`;

/** The managed block's lines, without the two markers. */
function blockLines(text: string): string[] {
  const read = readManagedBlock(text);
  if (!read.ok || read.block === null) throw new Error("expected a managed block");
  return read.block.content.slice(0, -1).split("\n");
}

describe("managedBlockHash", () => {
  it("is the first 16 hex characters of sha256 over the text", () => {
    // printf '@AGENTS.md\n' | shasum -a 256 starts 336cc4fbf19beaad.
    expect(managedBlockHash("@AGENTS.md\n")).toBe("336cc4fbf19beaad");
  });

  it("gives 16 lowercase hex characters, and a different hash for different text", () => {
    const hashes = ["a\n", "a", "é\n", "e\n"].map(managedBlockHash);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("renderManagedBlock", () => {
  it("puts the hash in the begin marker and the text between the markers", () => {
    expect(renderManagedBlock("one\ntwo\n")).toBe(
      `${BEGIN(managedBlockHash("one\ntwo\n"))}\none\ntwo\n${MANAGED_BLOCK_END}\n`,
    );
  });

  it("gives text with no final newline one, and hashes it with the newline", () => {
    expect(renderManagedBlock("one\ntwo")).toBe(renderManagedBlock("one\ntwo\n"));
  });

  it.each(["@AGENTS.md", "one\ntwo", "# Heading\n\n- item\n"])(
    "renders %j as a block readManagedBlock reads back intact",
    (content) => {
      const text = renderManagedBlock(content);
      const read = readManagedBlock(text);
      const expected = content.endsWith("\n") ? content : `${content}\n`;
      expect(read).toEqual({
        ok: true,
        block: {
          begin_line: 1,
          end_line: text.split("\n").length - 1,
          content: expected,
          declared_hash: managedBlockHash(expected),
          actual_hash: managedBlockHash(expected),
          intact: true,
        },
      });
    },
  );
});

describe("readManagedBlock", () => {
  const block = renderManagedBlock("one\ntwo");
  const hash = managedBlockHash("one\ntwo\n");

  it("returns no block for a file with no markers", () => {
    expect(readManagedBlock("# Notes\n\nNothing managed here.\n")).toEqual({
      ok: true,
      block: null,
    });
  });

  it.each([
    {
      name: "a second begin marker",
      text: `${block}${block}`,
      line: 5,
      message: "the file holds a second managed block",
    },
    {
      name: "a second end marker",
      text: `${BEGIN(hash)}\none\n${MANAGED_BLOCK_END}\n${MANAGED_BLOCK_END}\n`,
      line: 4,
      message: "the file holds a second managed block",
    },
    {
      name: "an end marker with no begin marker",
      text: `notes\n${MANAGED_BLOCK_END}\n`,
      line: 2,
      message: "the managed block needs one begin marker and one end marker after it",
    },
    {
      name: "a begin marker with no end marker",
      text: `${BEGIN(hash)}\none\ntwo\n`,
      line: 1,
      message: "the managed block needs one begin marker and one end marker after it",
    },
    {
      name: "an end marker before the begin marker",
      text: `${MANAGED_BLOCK_END}\n${BEGIN(hash)}\none\n`,
      line: 2,
      message: "the managed block needs one begin marker and one end marker after it",
    },
    {
      name: "a hash that is too short",
      text: `${BEGIN("abc123")}\none\n${MANAGED_BLOCK_END}\n`,
      line: 1,
      message: "the begin marker's hash is not 16 hex characters",
    },
    {
      name: "a hash in capital letters",
      text: `notes\n${BEGIN("336CC4FBF19BEAAD")}\none\n${MANAGED_BLOCK_END}\n`,
      line: 2,
      message: "the begin marker's hash is not 16 hex characters",
    },
  ])("refuses a file with $name", ({ text, line, message }) => {
    expect(readManagedBlock(text)).toEqual({
      ok: false,
      issue: { line, field: null, message },
    });
  });

  it("finds an intact block below and above text a person wrote", () => {
    expect(readManagedBlock(`# Notes\n\n${block}\nMore notes.\n`)).toEqual({
      ok: true,
      block: {
        begin_line: 3,
        end_line: 6,
        content: "one\ntwo\n",
        declared_hash: hash,
        actual_hash: hash,
        intact: true,
      },
    });
  });

  it("marks a block whose text changed after its hash was written as not intact", () => {
    expect(readManagedBlock(block.replace("two", "three"))).toEqual({
      ok: true,
      block: {
        begin_line: 1,
        end_line: 4,
        content: "one\nthree\n",
        declared_hash: hash,
        actual_hash: managedBlockHash("one\nthree\n"),
        intact: false,
      },
    });
  });
});

describe("agentsMdTemplate", () => {
  it.each(SCOPES)("writes the $name repository's block and the note below it", ({ input }) => {
    const text = agentsMdTemplate(input);
    const lines = blockLines(text);
    expect(lines[0]).toBe(`# ${input.repository}`);
    expect(lines).toContain(`- Frontmatter fields and kinds: ${schemaUrl("steering-record/v1")}`);
    expect(lines).toContain(
      `- One idea per file: steering/<any folder>/<lineage>.md, lineage like ${input.organization}.billing.refunds-over-100.`,
    );
    expect(text.endsWith(`${MANAGED_BLOCK_END}\n\nNotes your team adds go below the block.\n`)).toBe(true);
  });

  it.each([
    {
      name: "workspace",
      input: workspaceInput,
      steers: "This repository steers every agent in the Core platform workspace.",
    },
    {
      name: "organization",
      input: organizationInput,
      steers: "This repository steers every agent in every workspace of the a-intel organization.",
    },
  ])("names whom the $name repository steers", ({ input, steers }) => {
    expect(blockLines(agentsMdTemplate(input))).toContain(steers);
  });

  it.each(SCOPES)("is the same for both providers in the $name scope", ({ input }) => {
    const [github, gitlab] = PROVIDERS.map((provider) => agentsMdTemplate({ ...input, provider }));
    expect(gitlab).toBe(github);
  });
});

describe("claudeMdTemplate", () => {
  it("imports AGENTS.md from a managed block", () => {
    expect(claudeMdTemplate()).toBe(
      `${BEGIN("336cc4fbf19beaad")}\n@AGENTS.md\n${MANAGED_BLOCK_END}\n`,
    );
  });
});

describe("readmeTemplate", () => {
  const settings: Record<(typeof PROVIDERS)[number], string[]> = {
    github: [
      "- The repository is private.",
      `- The ruleset Oxagen steering on main requires a pull request and the ${REQUIRED_CHECK_NAME} check, and blocks force pushes and deletion.`,
      "- The ruleset Oxagen merges on main lets only Oxagen update it.",
      "- Pull requests merge by squash only, and head branches are deleted after a merge.",
      "- GitHub Actions is off.",
      "- The steering environment records each published version.",
    ],
    gitlab: [
      "- The project is private.",
      "- The protected branch main takes no pushes, and only the Oxagen bot merges into it.",
      `- Merge requests squash, and wait for the ${REQUIRED_CHECK_NAME} commit status.`,
      "- Source branches are deleted after a merge.",
      "- CI/CD is off.",
    ],
  };
  const holds = {
    workspace: "It holds the workspace's steering records, skills, tool servers, agents, and policies.",
    organization:
      "It holds the organization's records, and every workspace in the organization inherits them.",
  };
  const cases = PROVIDERS.flatMap((provider) =>
    SCOPES.map(({ name, input }) => ({ provider, name, input: { ...input, provider } })),
  );

  it.each(cases)("lists the settings Oxagen holds on $provider for the $name scope", ({ provider, input }) => {
    const lines = blockLines(readmeTemplate(input));
    const heading = lines.indexOf("## Settings Oxagen holds");
    expect(heading).toBeGreaterThan(0);
    expect(lines.slice(heading).filter((line) => line.startsWith("- "))).toEqual(settings[provider]);
  });

  it.each(cases)("says what the $name repository holds on $provider", ({ name, input }) => {
    const lines = blockLines(readmeTemplate(input));
    expect(lines[0]).toBe(`# ${input.repository}`);
    expect(lines).toContain(holds[name]);
    expect(lines).not.toContain(holds[name === "workspace" ? "organization" : "workspace"]);
    expect(lines).toContain(
      `Only Oxagen merges into main, and only after the ${REQUIRED_CHECK_NAME} check passes.`,
    );
  });

  it.each(cases)("is one intact managed block and nothing else on $provider for the $name scope", ({ input }) => {
    const text = readmeTemplate(input);
    expect(readManagedBlock(text)).toMatchObject({
      ok: true,
      block: { begin_line: 1, end_line: text.split("\n").length - 1, intact: true },
    });
  });
});

describe("the TOML and attribute templates", () => {
  it("sets LF line endings for every file", () => {
    expect(gitattributesTemplate()).toBe("* text=auto eol=lf\n");
  });

  it("writes workspace.toml with the organization and workspace and nothing linked", () => {
    const text = workspaceTomlTemplate("a-intel", "core-platform");
    expect(text).toBe(
      [
        schemaDirective("workspace/v1"),
        'schema = "workspace/v1"',
        'organization = "a-intel"',
        'workspace = "core-platform"',
        "",
      ].join("\n"),
    );
    expect(readTomlFile(text, "workspace/v1", workspaceSchema)).toEqual({
      ok: true,
      value: { schema: "workspace/v1", organization: "a-intel", workspace: "core-platform" },
    });
  });

  it("writes governance.toml in solo mode", () => {
    const text = governanceTomlTemplate();
    expect(text).toBe(
      [schemaDirective("governance/v1"), 'schema = "governance/v1"', 'mode = "solo"', ""].join("\n"),
    );
    expect(readTomlFile(text, "governance/v1", governanceSchema)).toEqual({
      ok: true,
      value: { schema: "governance/v1", mode: "solo" },
    });
  });
});

describe("firstCommitFiles", () => {
  it("writes six files for a workspace, in order", () => {
    expect(firstCommitFiles(workspaceInput)).toEqual([
      { path: README_PATH, content: readmeTemplate(workspaceInput) },
      { path: AGENTS_MD_PATH, content: agentsMdTemplate(workspaceInput) },
      { path: CLAUDE_MD_PATH, content: claudeMdTemplate() },
      { path: GITATTRIBUTES_PATH, content: gitattributesTemplate() },
      { path: WORKSPACE_TOML_PATH, content: workspaceTomlTemplate("a-intel", "core-platform") },
      { path: GOVERNANCE_TOML_PATH, content: governanceTomlTemplate() },
    ]);
  });

  it("writes no workspace.toml for an organization", () => {
    expect(firstCommitFiles(organizationInput).map((file) => file.path)).toEqual([
      README_PATH,
      AGENTS_MD_PATH,
      CLAUDE_MD_PATH,
      GITATTRIBUTES_PATH,
      GOVERNANCE_TOML_PATH,
    ]);
  });

  const allFiles = PROVIDERS.flatMap((provider) =>
    SCOPES.flatMap(({ name, input }) =>
      firstCommitFiles({ ...input, provider }).map((file) => ({ provider, name, ...file })),
    ),
  );

  it.each(allFiles)("writes $path on $provider for the $name scope so its reader accepts it", ({ path, content }) => {
    const kind = classifySteeringRepoPath(path);
    const reader = READERS[kind];
    if (reader === undefined) {
      expect(kind).toBe("gitattributes");
      return;
    }
    expect(reader(content)).toMatchObject({ ok: true });
  });

  it.each(allFiles.filter((file) => READERS[classifySteeringRepoPath(file.path)] === managedBlockOutcome))(
    "writes an intact managed block in $path on $provider for the $name scope",
    ({ content }) => {
      const read = readManagedBlock(content);
      expect(read.ok && read.block?.intact).toBe(true);
    },
  );
});

describe("the committed fixtures", () => {
  // repo/ has taken steering PRs since its first commit: workspace.toml
  // gained linked repositories and settings, and governance.toml moved to
  // team mode. Those two keep the template's opening lines.
  const editedSince = new Set([WORKSPACE_TOML_PATH, GOVERNANCE_TOML_PATH]);

  it.each(firstCommitFiles(workspaceInput))("repo/ holds $path as the workspace template wrote it", ({ path, content }) => {
    const committed = fixtureRepo().get(path);
    if (!editedSince.has(path)) {
      expect(committed).toBe(content);
      return;
    }
    const opening = content.split("\n").slice(0, 2).join("\n");
    expect(committed?.startsWith(`${opening}\n`)).toBe(true);
  });

  it("repo/ keeps the workspace template as the start of workspace.toml", () => {
    const committed = fixtureRepo().get(WORKSPACE_TOML_PATH);
    expect(committed?.startsWith(workspaceTomlTemplate("a-intel", "core-platform"))).toBe(true);
  });

  it.each(firstCommitFiles(organizationInput))(
    "org-repo/ holds $path exactly as the organization template wrote it",
    ({ path, content }) => {
      expect(organizationFixtureRepo().get(path)).toBe(content);
    },
  );
});
