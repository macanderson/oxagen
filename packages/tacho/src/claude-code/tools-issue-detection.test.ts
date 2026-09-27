// The issue a tool call acted on, as the effect frame's `issue.*` attrs
// (#3970). get_run_issues reads them for the calls a command head cannot
// name: a GitHub MCP issue tool, whose input the frame keeps as a digest, and
// `gh issue create`, whose number exists only once it has run.
import { describe, expect, it } from "vitest";
import { normalizeHook } from "./hooks";
import { issueAttrs, releaseAttrs } from "./tools";

const acme = (number: number, action: string) => ({
  "issue.repository": "acme/app",
  "issue.number": String(number),
  "issue.url": `https://github.com/acme/app/issues/${String(number)}`,
  "issue.action": action,
});

describe("issueAttrs from a GitHub MCP issue tool", () => {
  it.each([
    ["mcp__github__issue_read", { method: "get" }, "viewed"],
    ["mcp__github__get_issue", {}, "viewed"],
    ["mcp__github__add_issue_comment", { body: "on it" }, "commented"],
    ["mcp__github__issue_write", { method: "update", title: "x" }, "edited"],
    ["mcp__github__issue_write", { method: "update", state: "closed" }, "closed"],
    ["mcp__github__update_issue", { state: "open" }, "reopened"],
    ["mcp__github__sub_issue_write", { method: "add", sub_issue_id: 9 }, "edited"],
    ["mcp__gh_enterprise__githubUpdateIssue", {}, "edited"],
    ["MCP:get_issue", {}, "viewed"],
  ])("reads %s as the run %s its issue", (tool, input, action) => {
    expect(
      issueAttrs(tool, { owner: "acme", repo: "app", issue_number: 482, ...input }, {}),
    ).toEqual(acme(482, action));
  });

  it("names a created issue from the response, which is the only place its number is", () => {
    expect(
      issueAttrs(
        "mcp__github__issue_write",
        { method: "create", owner: "acme", repo: "app", title: "Bug" },
        { html_url: "https://github.com/acme/app/issues/500", number: 500 },
      ),
    ).toEqual(acme(500, "created"));
    expect(
      issueAttrs(
        "mcp__github__create_issue",
        { owner: "acme", repo: "app", title: "Bug" },
        '{"url":"https://github.com/acme/app/issues/501"}',
      ),
    ).toEqual(acme(501, "created"));
  });

  it.each([
    ["a list names no one issue", "mcp__github__list_issues", { owner: "acme", repo: "app" }],
    ["a search names no one issue", "mcp__github__search_issues", { query: "bug" }],
    ["a pull request tool is not an issue", "mcp__github__get_pull_request", { owner: "acme", repo: "app", pullNumber: 5 }],
    ["no number was given", "mcp__github__get_issue", { owner: "acme", repo: "app" }],
    ["a repository it cannot read", "mcp__github__get_issue", { owner: "acme/x", repo: "app", issue_number: 3 }],
    ["a create whose response names no issue", "mcp__github__create_issue", { owner: "acme", repo: "app" }],
  ])("names nothing when %s (negative)", (_why, tool, input) => {
    expect(issueAttrs(tool, input, {})).toEqual({});
  });
});

describe("issueAttrs from gh issue create", () => {
  it("reads the new issue's URL from stdout", () => {
    for (const command of [
      "gh issue create -t Bug -b 'see logs'",
      "cd app && gh issue create --title Bug --body x",
      "gh -R acme/app issue create -t Bug",
      "GH_TOKEN=x gh issue create -t Bug",
    ])
      expect(
        issueAttrs(
          "Bash",
          { command },
          {
            stdout:
              "Creating issue in acme/app\n\nhttps://github.com/acme/app/issues/77\n",
          },
        ),
        command,
      ).toEqual(acme(77, "created"));
  });

  it.each([
    ["a view creates nothing", "gh issue view 77"],
    ["echo only prints the words", "echo gh issue create"],
    ["a pull request is not an issue", "gh pr create --fill"],
  ])("names nothing when %s (negative)", (_why, command) => {
    expect(
      issueAttrs(
        "Bash",
        { command },
        { stdout: "https://github.com/acme/app/issues/77" },
      ),
    ).toEqual({});
  });

  it("names nothing when the command printed no issue URL (negative)", () => {
    expect(
      issueAttrs(
        "Bash",
        { command: "gh issue create -t Bug" },
        { stdout: "", stderr: "GraphQL: Could not resolve to a Repository" },
      ),
    ).toEqual({});
  });
});

// #3890: the release a GitHub MCP call created is named only in its input.
describe("releaseAttrs", () => {
  it("names the repository and tag a GitHub MCP release call created", () => {
    for (const tool of [
      "mcp__github__create_release",
      "mcp__gh__githubCreateRelease",
      "MCP:release_create",
    ])
      expect(
        releaseAttrs(tool, { owner: "acme", repo: "app", tag_name: "v4.11.0" }),
        tool,
      ).toEqual({ "release.repository": "acme/app", "release.tag": "v4.11.0" });
  });

  it.each([
    ["a list creates nothing", "mcp__github__list_releases", { owner: "acme", repo: "app" }],
    ["no tag was given", "mcp__github__create_release", { owner: "acme", repo: "app" }],
    ["a shell call names its tag in the command head", "Bash", { command: "gh release create v1" }],
    ["a repository it cannot read", "mcp__github__create_release", { owner: "a/b", repo: "app", tag_name: "v1" }],
  ])("names nothing when %s (negative)", (_why, tool, input) => {
    expect(releaseAttrs(tool, input)).toEqual({});
  });
});

describe("the effect frame carries the issue attrs", () => {
  const hook = (payload: Record<string, unknown>) =>
    normalizeHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "00000000-0000-4000-8000-000000000001",
        cwd: "/home/dev/proj",
        transcript_path: "/t.jsonl",
        ...payload,
      },
      { CLAUDE_CODE_ENTRYPOINT: "cli" },
      { sessionUuid: "11111111-1111-4111-8111-111111111111" },
    );

  it("writes them on a GitHub MCP issue call's network frame", () => {
    const drafts = hook({
      tool_name: "mcp__github__add_issue_comment",
      tool_input: { owner: "acme", repo: "app", issue_number: 482, body: "x" },
      tool_use_id: "toolu_issue_1",
      tool_response: { id: 1 },
    });
    expect(drafts.map((d) => d.kind)).toEqual(["tool_call", "network"]);
    expect(drafts[1]?.attrs).toMatchObject(acme(482, "commented"));
    // The tool_call frame keeps its own attrs; only the effect frame names it.
    expect(drafts[0]?.attrs).not.toHaveProperty("issue.number");
  });

  it("writes them on gh issue create's command frame", () => {
    const drafts = hook({
      tool_name: "Bash",
      tool_input: { command: "gh issue create -t Bug" },
      tool_use_id: "toolu_issue_2",
      tool_response: { stdout: "https://github.com/acme/app/issues/77\n" },
    });
    expect(drafts.map((d) => d.kind)).toEqual(["tool_call", "command"]);
    expect(drafts[1]?.attrs).toMatchObject(acme(77, "created"));
  });

  it("writes the release attrs on a GitHub MCP release call's network frame", () => {
    const drafts = hook({
      tool_name: "mcp__github__create_release",
      tool_input: { owner: "acme", repo: "app", tag_name: "v4.11.0", draft: true },
      tool_use_id: "toolu_release_1",
      tool_response: { id: 1 },
    });
    expect(drafts.map((d) => d.kind)).toEqual(["tool_call", "network"]);
    expect(drafts[1]?.attrs).toMatchObject({
      "release.repository": "acme/app",
      "release.tag": "v4.11.0",
    });
  });

  it("leaves a call that names no issue as it was (negative)", () => {
    const drafts = hook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_use_id: "toolu_issue_3",
      tool_response: { stdout: "clean" },
    });
    expect(drafts[1]?.attrs).not.toHaveProperty("issue.number");
  });
});
