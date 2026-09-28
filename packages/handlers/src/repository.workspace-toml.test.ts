// repository.workspace-toml.test.ts: how the handlers and the steering sync
// read workspace.toml, and how a steering PR edits its `[[repositories]]`
// list (ADR-212).
//
// Every expected file is built from the same line lists as the fixture it
// came from, so a test states which lines an edit adds or drops.
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import { workspaceTomlTemplate } from "@oxagen/oxagen/steering-repo/templates";
import { describe, expect, it } from "vitest";
import {
  GITHUB_HOST,
  githubRepoRef,
  listedRepositories,
  newWorkspaceToml,
  readWorkspaceToml,
  splitRepoRef,
  type WorkspaceToml,
  withoutRepository,
  withRepository,
} from "./repository.workspace-toml";

const API = "github.com/a-intel/api";
const WEB = "github.com/a-intel/web";
const DOCS = "github.com/a-intel/docs";

/** The directive and the three keys every workspace/v1 file carries. */
const HEAD = [
  schemaDirective("workspace/v1"),
  'schema = "workspace/v1"',
  'organization = "a-intel"',
  'workspace = "core-platform"',
];

/** Every optional setting workspace/v1 allows, with a comment above them. */
const SETTINGS = [
  "",
  "# Spend and checks.",
  "[budget]",
  "per_month_micros = 5000000",
  "",
  "[code_checks]",
  "block_merge = true",
  "",
  "[tools]",
  "definition_budget = 30000",
  "",
  "[embeddings]",
  'provider = "keyword"',
  "",
  "[stella]",
  "archive_after_days = 14",
];

/** One `[[repositories]]` entry, with the blank line an edit adds before it. */
function entry(url: string): string[] {
  return ["", "[[repositories]]", `url = "${url}"`];
}

/** The lines joined as a file that ends with a newline. */
function toml(...parts: string[][]): string {
  return [...parts.flat(), ""].join("\n");
}

/** A file with every setting and two linked repositories. */
const FULL = toml(HEAD, SETTINGS, entry(API), entry(WEB));

/** What FULL reads as, before its repositories. */
const FULL_SETTINGS = {
  schema: "workspace/v1",
  organization: "a-intel",
  workspace: "core-platform",
  budget: { per_month_micros: 5000000 },
  code_checks: { block_merge: true },
  tools: { definition_budget: 30000 },
  embeddings: { provider: "keyword" },
  stella: { archive_after_days: 14 },
};

type ReadWorkspaceToml = Extract<WorkspaceToml, { kind: "read" }>;

/** `text` read as workspace.toml. The test fails when it does not read. */
function readable(text: string): ReadWorkspaceToml {
  const file = readWorkspaceToml(text);
  if (file.kind !== "read") {
    throw new Error(
      `expected workspace.toml to read, but it was ${file.kind}: ${JSON.stringify(file)}`,
    );
  }
  return file;
}

describe("readWorkspaceToml", () => {
  it("reads a file the ref does not have as missing", () => {
    expect(readWorkspaceToml(null)).toEqual({ kind: "missing" });
  });

  it("reads a file whose first line is not the workspace/v1 directive as foreign", () => {
    expect(readWorkspaceToml('name = "x"\n')).toEqual({ kind: "foreign" });
    expect(
      readWorkspaceToml(
        '#:schema https://oxagen.sh/schemas/agent/v1.json\nname = "x"\n',
      ),
    ).toEqual({ kind: "foreign" });
  });

  it("reads an empty file as foreign", () => {
    expect(readWorkspaceToml("")).toEqual({ kind: "foreign" });
  });

  it("reads a file with a byte-order mark as unreadable, not foreign", () => {
    expect(readWorkspaceToml(`﻿${FULL}`)).toEqual({
      kind: "unreadable",
      issues: [
        {
          line: 1,
          field: null,
          message: expect.stringContaining("byte-order mark"),
        },
      ],
    });
  });

  it("reads a file with CRLF line endings as unreadable, not foreign", () => {
    const crlf = [...HEAD, ...entry(API), ""].join("\r\n");
    expect(readWorkspaceToml(crlf)).toEqual({
      kind: "unreadable",
      issues: [
        {
          line: 1,
          field: null,
          message: "the file has CRLF line endings. Use LF.",
        },
      ],
    });
  });

  it("reports a repository url in the wrong case on the first entry's line", () => {
    const file = readWorkspaceToml(toml(HEAD, entry("github.com/A-Intel/API")));
    expect(file).toEqual({
      kind: "unreadable",
      issues: [
        {
          line: 6,
          field: "repositories.0.url",
          message:
            "a repository is <host>/<owner>/<name> in lowercase, such as github.com/a-intel/platform",
        },
      ],
    });
  });

  it("reports a key a repository entry does not allow", () => {
    const file = readWorkspaceToml(
      toml(HEAD, [...entry(API), 'branch = "main"']),
    );
    expect(file).toEqual({
      kind: "unreadable",
      issues: [
        {
          line: 6,
          field: "repositories.0.branch",
          message: "branch is not a known field. Remove it or check its spelling.",
        },
      ],
    });
  });

  it("reports a repository the file lists twice", () => {
    const file = readWorkspaceToml(toml(HEAD, entry(API), entry(API)));
    expect(file).toEqual({
      kind: "unreadable",
      issues: [
        {
          line: 6,
          field: "repositories.1",
          message: `repositories lists {"url":"${API}"} twice`,
        },
      ],
    });
  });

  it("reports a file that is not TOML", () => {
    const file = readWorkspaceToml(toml(HEAD, ["[[repositories]]", "url = "]));
    expect(file.kind).toBe("unreadable");
    if (file.kind !== "unreadable") return;
    expect(file.issues).toHaveLength(1);
    expect(file.issues[0]).toEqual(
      expect.objectContaining({
        field: null,
        message: expect.stringContaining("the file is not TOML"),
      }),
    );
  });

  it("reads a good file with its text, its value, and its repositories in file order", () => {
    expect(readWorkspaceToml(FULL)).toEqual({
      kind: "read",
      text: FULL,
      value: {
        ...FULL_SETTINGS,
        repositories: [{ url: API }, { url: WEB }],
      },
      repositories: [API, WEB],
    });
  });

  it("reads a file with no repositories as an empty list", () => {
    const file = readable(toml(HEAD));
    expect(file.repositories).toEqual([]);
    expect(file.value.repositories).toBeUndefined();
  });
});

describe("listedRepositories", () => {
  it("lists nothing for a missing file", () => {
    expect(listedRepositories({ kind: "missing" })).toEqual([]);
  });

  it("lists nothing for a foreign file", () => {
    expect(listedRepositories({ kind: "foreign" })).toEqual([]);
  });

  it("answers null for an unreadable file, because nobody can tell what it lists", () => {
    expect(listedRepositories({ kind: "unreadable", issues: [] })).toBeNull();
    expect(
      listedRepositories(readWorkspaceToml(toml(HEAD, entry(API), entry(API)))),
    ).toBeNull();
  });

  it("lists the repositories of a file that reads", () => {
    const file = readable(FULL);
    expect(listedRepositories(file)).toEqual([API, WEB]);
    expect(listedRepositories(file)).toBe(file.repositories);
  });
});

describe("githubRepoRef", () => {
  it("puts the GitHub host first and lowercases the owner and the name", () => {
    expect(GITHUB_HOST).toBe("github.com");
    expect(githubRepoRef("Acme", "Docs")).toBe("github.com/acme/docs");
  });

  it("keeps the dots, underscores, and hyphens a GitHub name may hold", () => {
    expect(githubRepoRef("a-intel", "Platform_API.js")).toBe(
      "github.com/a-intel/platform_api.js",
    );
  });

  it("throws a RangeError for a name no reference can spell", () => {
    expect(() => githubRepoRef("Acme", "my repo")).toThrow(RangeError);
    expect(() => githubRepoRef("Acme", "my repo")).toThrow(
      "github.com/acme/my repo is not a repository reference. Write it as <host>/<owner>/<name>, such as github.com/a-intel/platform.",
    );
    expect(() => githubRepoRef("acme", "..")).toThrow(RangeError);
    expect(() => githubRepoRef("acme", "")).toThrow(RangeError);
  });
});

describe("splitRepoRef", () => {
  it("splits a GitHub reference into its host, owner, and name", () => {
    expect(splitRepoRef("github.com/acme/docs")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "docs",
    });
  });

  it("keeps a GitLab subgroup path in the owner and takes the last segment as the name", () => {
    expect(splitRepoRef("gitlab.com/acme/platform/tools/api")).toEqual({
      host: "gitlab.com",
      owner: "acme/platform/tools",
      name: "api",
    });
  });

  it("round-trips a reference on any host", () => {
    for (const ref of [
      "github.com/acme/docs",
      "gitlab.com/acme/platform/tools/api",
      "git.example.com/team/svc",
    ]) {
      const { host, owner, name } = splitRepoRef(ref);
      expect(`${host}/${owner}/${name}`).toBe(ref);
    }
  });

  it("gives back the owner and the name githubRepoRef was given, lowercased", () => {
    expect(splitRepoRef(githubRepoRef("Acme", "Docs"))).toEqual({
      host: GITHUB_HOST,
      owner: "acme",
      name: "docs",
    });
  });
});

describe("newWorkspaceToml", () => {
  it("writes the template and one repository entry", () => {
    const text = newWorkspaceToml("a-intel", "core-platform", API);
    expect(text).toBe(
      `${workspaceTomlTemplate("a-intel", "core-platform")}\n[[repositories]]\nurl = "${API}"\n`,
    );
    expect(text).toBe(toml(HEAD, entry(API)));
  });

  it("reads back as workspace/v1 with exactly that repository", () => {
    const file = readable(newWorkspaceToml("a-intel", "core-platform", API));
    expect(file.repositories).toEqual([API]);
    expect(file.value).toEqual({
      schema: "workspace/v1",
      organization: "a-intel",
      workspace: "core-platform",
      repositories: [{ url: API }],
    });
  });

  it("throws when the organization slug does not read as workspace/v1", () => {
    expect(() => newWorkspaceToml("A Intel", "core-platform", API)).toThrow(
      "[repository.workspace-toml] a new workspace.toml for A Intel/core-platform does not read as workspace/v1",
    );
  });

  it("throws when the reference is not lowercase", () => {
    expect(() =>
      newWorkspaceToml("a-intel", "core-platform", "github.com/Acme/Docs"),
    ).toThrow(
      "[repository.workspace-toml] a new workspace.toml for a-intel/core-platform does not read as workspace/v1",
    );
  });
});

describe("withRepository", () => {
  it("appends an entry and keeps every other line of the file", () => {
    const text = withRepository(readable(FULL), DOCS);
    expect(text).toBe(toml(HEAD, SETTINGS, entry(API), entry(WEB), entry(DOCS)));
  });

  it("reads back with the new repository last and every setting unchanged", () => {
    const file = readable(withRepository(readable(FULL), DOCS));
    expect(file.repositories).toEqual([API, WEB, DOCS]);
    expect(file.value).toEqual({
      ...FULL_SETTINGS,
      repositories: [{ url: API }, { url: WEB }, { url: DOCS }],
    });
  });

  it("adds the first entry to a file that lists none", () => {
    const text = withRepository(readable(toml(HEAD)), DOCS);
    expect(text).toBe(toml(HEAD, entry(DOCS)));
    expect(readable(text).repositories).toEqual([DOCS]);
  });

  it("throws when the file already lists the repository", () => {
    expect(() => withRepository(readable(FULL), API)).toThrow(
      "[repository.workspace-toml] an edit to workspace.toml did not read back as the list it was meant to hold",
    );
  });

  it("writes the file again from its value when the list is an inline array", () => {
    const inline = toml(HEAD, [
      `repositories = [ { url = "${API}" } ]`,
      "",
      "# Spend.",
      "[budget]",
      "per_month_micros = 5000000",
    ]);
    const text = withRepository(readable(inline), DOCS);
    const file = readable(text);
    expect(file.repositories).toEqual([API, DOCS]);
    expect(file.value.budget).toEqual({ per_month_micros: 5000000 });
    // The rewrite starts from the parsed value, which holds no comments.
    expect(text).not.toContain("# Spend.");
  });
});

describe("withoutRepository", () => {
  it("removes the first entry and the blank line that came with it", () => {
    const text = withoutRepository(readable(FULL), API);
    expect(text).toBe(toml(HEAD, SETTINGS, entry(WEB)));
  });

  it("removes the last entry and the blank line that came with it", () => {
    const text = withoutRepository(readable(FULL), WEB);
    expect(text).toBe(toml(HEAD, SETTINGS, entry(API)));
  });

  it("keeps every setting of the file it edits", () => {
    const file = readable(withoutRepository(readable(FULL), API));
    expect(file.repositories).toEqual([WEB]);
    expect(file.value).toEqual({
      ...FULL_SETTINGS,
      repositories: [{ url: WEB }],
    });
  });

  it("gives back the template when it removes the only entry", () => {
    const only = readable(newWorkspaceToml("a-intel", "core-platform", API));
    const text = withoutRepository(only, API);
    expect(text).toBe(workspaceTomlTemplate("a-intel", "core-platform"));
    expect(readable(text).repositories).toEqual([]);
  });

  it("returns the file unchanged when it does not list the repository", () => {
    expect(withoutRepository(readable(FULL), DOCS)).toBe(FULL);
  });

  it("keeps a comment that introduces the next entry", () => {
    const withComment = toml(HEAD, entry(API), [
      "",
      "# The web front end.",
      "[[repositories]]",
      `url = "${WEB}"`,
    ]);
    const text = withoutRepository(readable(withComment), API);
    expect(text).toBe(
      toml(HEAD, [
        "",
        "# The web front end.",
        "[[repositories]]",
        `url = "${WEB}"`,
      ]),
    );
    expect(readable(text).repositories).toEqual([WEB]);
  });

  it("finds an entry whose url is single-quoted", () => {
    const singleQuoted = toml(
      HEAD,
      ["", "[[repositories]]", `url = '${API}'`],
      entry(WEB),
    );
    const text = withoutRepository(readable(singleQuoted), API);
    expect(text).toBe(toml(HEAD, entry(WEB)));
    expect(readable(text).repositories).toEqual([WEB]);
  });

  it("finds an entry whose url line ends in a comment", () => {
    const commented = toml(
      HEAD,
      ["", "[[repositories]]", `url = "${API}" # the API`],
      entry(WEB),
    );
    const text = withoutRepository(readable(commented), API);
    expect(text).toBe(toml(HEAD, entry(WEB)));
  });

  it("writes the file again from its value when the list is an inline array", () => {
    const inline = toml(HEAD, [
      `repositories = [ { url = "${API}" }, { url = "${WEB}" } ]`,
    ]);
    const file = readable(withoutRepository(readable(inline), API));
    expect(file.repositories).toEqual([WEB]);
    expect(file.value).toEqual({
      schema: "workspace/v1",
      organization: "a-intel",
      workspace: "core-platform",
      repositories: [{ url: WEB }],
    });
  });
});
