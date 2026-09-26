import { tachoEventsColumns } from "@oxagen/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueRefOfAttrs,
  issueRefsOfCommand,
  issueRefsOfFrame,
  readRunCommandRefFrames,
  releaseRefsOfCommand,
  releaseRefsOfFrame,
  type CommandRefFrameRow,
} from "./run-command-refs";

const chSelect = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/telemetry", async (original) => ({
  ...(await original<typeof import("@oxagen/telemetry")>()),
  chSelect,
}));

const acme = { owner: "acme", name: "app" };

describe("issueRefsOfCommand (#3970)", () => {
  it.each([
    ["gh issue view 482", "viewed"],
    ["gh issue comment 482 --body 'on it'", "commented"],
    ["gh issue edit 482 --add-label bug", "edited"],
    ["gh issue close 482 -c 'done in #511'", "closed"],
    ["gh issue reopen 482", "reopened"],
    ["gh issue develop 482 --checkout", "edited"],
    ["gh issue lock 482 -r resolved", "edited"],
    ["gh issue view '#482'", "viewed"],
  ])("reads `%s` as a bare issue the run %s", (command, action) => {
    expect(issueRefsOfCommand(command)).toEqual([
      { repository: null, number: 482, action, url: null },
    ]);
  });

  it("takes the repository from -R, --repo, --repo= and GH_REPO", () => {
    for (const command of [
      "gh issue view 7 -R acme/app",
      "gh issue -R acme/app view 7",
      "gh issue view --repo acme/app 7",
      "gh issue view 7 --repo=acme/app",
      "GH_REPO=acme/app gh issue view 7",
      "gh issue view 7 -R github.com/acme/app",
    ])
      expect(issueRefsOfCommand(command)).toEqual([
        { repository: acme, number: 7, action: "viewed", url: null },
      ]);
  });

  it("reads an issue URL as its own repository, and counts it once", () => {
    expect(
      issueRefsOfCommand(
        "gh issue comment https://github.com/acme/app/issues/9 -b 'fixed in https://github.com/acme/app/issues/9'",
      ),
    ).toEqual([
      {
        repository: acme,
        number: 9,
        action: "commented",
        url: "https://github.com/acme/app/issues/9",
      },
    ]);
  });

  it("reads every simple command of a line, and still reads one before a pipe or a redirection", () => {
    expect(
      issueRefsOfCommand(
        "cd /work/app && gh issue view 3 --json title | jq .title; gh issue close 4 2>&1",
      ).map(({ number, action }) => [number, action]),
    ).toEqual([
      [3, "viewed"],
      [4, "closed"],
    ]);
  });

  it("reads every issue gh issue edit names, and stops at the first word that is not one", () => {
    expect(
      issueRefsOfCommand("gh issue edit 1 2 3 --add-label p1").map(
        ({ number }) => number,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("reads gh api issue endpoints with what the method does", () => {
    const refs = [
      "gh api repos/acme/app/issues/5",
      "gh api /repos/acme/app/issues/5/comments -f body=hi",
      "gh api -X PATCH repos/acme/app/issues/5 -f state=closed",
      "gh api --method=PATCH repos/acme/app/issues/5 -f state=open",
      "gh api -X PATCH repos/acme/app/issues/5 -f title=new",
      "gh api -X POST repos/acme/app/issues/5/labels -f labels[]=bug",
      "gh api repos/acme/app/issues/5/comments --paginate",
    ].map((command) => issueRefsOfCommand(command)[0]?.action);
    expect(refs).toEqual([
      "viewed",
      "commented",
      "closed",
      "reopened",
      "edited",
      "edited",
      "viewed",
    ]);
    expect(issueRefsOfCommand("gh api repos/{owner}/{repo}/issues/5")).toEqual(
      [{ repository: null, number: 5, action: "viewed", url: null }],
    );
  });

  it("reads a literal issue URL anywhere in the line as mentioned", () => {
    expect(
      issueRefsOfCommand(
        'git commit -m "Refs https://github.com/acme/app/issues/12"',
      ),
    ).toEqual([
      {
        repository: acme,
        number: 12,
        action: "mentioned",
        url: "https://github.com/acme/app/issues/12",
      },
    ]);
  });

  it.each([
    ["a list names no issue", "gh issue list --state open"],
    ["a create names no number until it runs", "gh issue create -t Bug -b x"],
    ["echo only prints the words", "echo gh issue view 3"],
    ["a pull request is not an issue", "gh pr view 12"],
    ["a help request touches nothing", "gh issue view --help"],
    ["a pull request URL is not an issue", "open https://github.com/acme/app/pull/3"],
    [
      "a here-document body is text",
      "cat <<EOF > notes.md\ngh issue close 3\nhttps://github.com/acme/app/issues/3\nEOF",
    ],
    [
      "an unknown flag before the target stops the read",
      "gh issue edit --frobnicate 3 4",
    ],
    ["a value flag's number is not the issue", "gh issue view --json 3"],
    [
      "a repository on another host is not guessed",
      "gh issue view 3 -R ghe.example.com/acme/app",
    ],
    ["a commented-out command runs nothing", "# gh issue close 3"],
  ])("names nothing when %s (negative)", (_why, command) => {
    expect(issueRefsOfCommand(command)).toEqual([]);
  });
});

describe("releaseRefsOfCommand (#3890)", () => {
  it("reads the tag of each gh release create, with the repository it names", () => {
    expect(
      releaseRefsOfCommand(
        "gh release create v4.11.0 --draft --title 'v4.11.0' --notes-file notes.md dist/app.tgz && gh release create -R acme/app v4.11.1 -p",
      ),
    ).toEqual([
      { repository: null, tag: "v4.11.0" },
      { repository: acme, tag: "v4.11.1" },
    ]);
    expect(
      releaseRefsOfCommand("GH_REPO=acme/app gh release create v1 -n 'x'"),
    ).toEqual([{ repository: acme, tag: "v1" }]);
  });

  it.each([
    ["a list creates nothing", "gh release list"],
    ["a view creates nothing", "gh release view v1"],
    ["no tag was given", "gh release create --draft"],
    ["echo only prints the words", "echo gh release create v1"],
    ["a help request creates nothing", "gh release create --help"],
    ["an unknown flag before the tag", "gh release create --zzz v1"],
  ])("reads no release when %s (negative)", (_why, command) => {
    expect(releaseRefsOfCommand(command)).toEqual([]);
  });
});

describe("releaseRefsOfFrame", () => {
  const row = (over: Partial<CommandRefFrameRow>): CommandRefFrameRow => ({
    seq: 7,
    command: "",
    path: "/work/app",
    observed_at: "2026-09-26 10:00:00.000",
    issue_repository: "",
    issue_number: "",
    issue_url: "",
    issue_action: "",
    release_repository: "",
    release_tag: "",
    ...over,
  });

  it("reads the release a GitHub MCP call created from the recorder's attrs", () => {
    expect(
      releaseRefsOfFrame(
        row({
          command: "api.githubcopilot.com",
          release_repository: "acme/app",
          release_tag: "v4.11.0",
        }),
      ),
    ).toEqual([{ repository: acme, tag: "v4.11.0" }]);
  });

  it("counts a tag the attrs and the command both name once", () => {
    expect(
      releaseRefsOfFrame(
        row({
          command: "gh release create v1 --draft",
          release_repository: "acme/app",
          release_tag: "v1",
        }),
      ),
    ).toEqual([{ repository: acme, tag: "v1" }]);
  });

  it("reads no release from an attr whose repository it cannot read (negative)", () => {
    expect(
      releaseRefsOfFrame(
        row({ release_repository: "acme", release_tag: "v1" }),
      ),
    ).toEqual([]);
  });
});

describe("issueRefOfAttrs", () => {
  it("reads the recorder's issue attrs, the repository attr first", () => {
    expect(
      issueRefOfAttrs({
        repository: "acme/app",
        number: "44",
        url: "https://github.com/acme/app/issues/44",
        action: "created",
      }),
    ).toEqual({
      repository: acme,
      number: 44,
      action: "created",
      url: "https://github.com/acme/app/issues/44",
    });
    // The URL fills a missing repository and number.
    expect(
      issueRefOfAttrs({
        repository: "",
        number: "",
        url: "https://github.com/acme/app/issues/45",
        action: "zapped",
      }),
    ).toMatchObject({ repository: acme, number: 45, action: "mentioned" });
  });

  it("reads nothing from a frame without a number (negative)", () => {
    expect(
      issueRefOfAttrs({ repository: "acme/app", number: "", url: "", action: "" }),
    ).toBeNull();
  });
});

describe("issueRefsOfFrame", () => {
  const row = (over: Partial<CommandRefFrameRow>): CommandRefFrameRow => ({
    seq: 7,
    command: "",
    path: "/work/app",
    observed_at: "2026-09-26 10:00:00.000",
    issue_repository: "",
    issue_number: "",
    issue_url: "",
    issue_action: "",
    release_repository: "",
    release_tag: "",
    ...over,
  });

  it("gives a bare number the command names the repository the recorder named", () => {
    expect(
      issueRefsOfFrame(
        row({
          command: "gh issue comment 8 -b done",
          issue_repository: "acme/app",
          issue_number: "8",
          issue_action: "commented",
        }),
      ).map(({ repository, number, action }) => [repository, number, action]),
    ).toEqual([
      [acme, 8, "commented"],
      [acme, 8, "commented"],
    ]);
  });

  it("reads a frame with only a command the way the command reads", () => {
    expect(issueRefsOfFrame(row({ command: "gh issue view 3" }))).toEqual([
      { repository: null, number: 3, action: "viewed", url: null },
    ]);
  });
});

describe("readRunCommandRefFrames", () => {
  beforeEach(() => {
    chSelect.mockReset();
    chSelect.mockResolvedValue({ data: [] });
  });

  async function query(): Promise<string> {
    await readRunCommandRefFrames("0192d4a8-7c1e-7a00-8000-00000000c0de");
    return (chSelect.mock.calls[0]?.[0] as { query: string }).query;
  }

  // The alias that failed every get_run_work call in production (code 184,
  // 2026-09-24) reused a column name; this read names none.
  it("names no alias after a tacho_events column", async () => {
    const columns = new Set(tachoEventsColumns().map(({ name }) => name));
    const aliases = [...(await query()).matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)]
      .map((match) => match[1] ?? "");
    expect(aliases.length).toBeGreaterThan(0);
    expect(aliases.filter((alias) => columns.has(alias))).toEqual([]);
  });

  it("filters on the session in its workspace, reads past a chain break, and asks for one frame over the cap", async () => {
    const text = await query();
    expect(text).toContain("org_id = {orgId:UUID}");
    expect(text).toContain("workspace_id = {workspaceId:UUID}");
    expect(text).toContain("session_uuid = {sessionUuid:UUID}");
    expect(text).toContain("kind IN ('command', 'network')");
    expect(text).not.toMatch(/chain_verified/);
    expect(chSelect.mock.calls[0]?.[0]).toMatchObject({
      params: { limit: 2001 },
    });
  });
});
