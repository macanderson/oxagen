import { describe, expect, it } from "vitest";
import {
  classifyShellEffect,
  classifyTool,
  pullRequestAttrs,
  splitCommandList,
  tokenizeSimpleCommand,
} from "./tools";

describe("pull request detection in a shell line", () => {
  it("finds gh pr create inside a line of several commands", () => {
    for (const command of [
      "git push -u origin HEAD && gh pr create --fill",
      "cd packages/tacho && gh pr create --title x --body y",
      "git push; gh pr create --fill",
      "git push\ngh pr create --fill",
      "gh pr create --fill || gh pr view --web",
      'git push && gh pr create --title "fix: a && b" --body "$(cat <<\'EOF\'\nbody; git push\nEOF\n)"',
    ]) {
      expect(classifyShellEffect(command), command).toBe("pr_open");
    }
  });

  it("reads past variable assignments and the repository option", () => {
    for (const command of [
      "GH_TOKEN=abc gh pr create --fill",
      'GH_TOKEN="a b" GH_HOST=github.com gh pr create --fill',
      "gh -R owner/repo pr create --fill",
      "gh --repo owner/repo pr create --fill",
      "gh --repo=owner/repo pr create --fill",
      "gh -Rowner/repo pr create --fill",
      "gh pr create -R owner/repo --fill",
    ]) {
      expect(classifyShellEffect(command), command).toBe("pr_open");
    }
    expect(classifyShellEffect("GH_TOKEN=abc")).toBeUndefined();
    expect(classifyShellEffect("gh -R owner/repo pr list")).toBeUndefined();
  });

  it("reports the effect that reaches furthest when a line has several", () => {
    expect(classifyShellEffect("git add . && git commit -m x")).toBe(
      "git_commit",
    );
    expect(classifyShellEffect("git commit -m x && git push")).toBe("git_push");
    expect(
      classifyShellEffect("git commit -m x && git push && gh pr create --fill"),
    ).toBe("pr_open");
    expect(classifyShellEffect("cd repo && git push origin main")).toBe(
      "git_push",
    );
    // A dry run opens nothing, so the push is what the line did.
    expect(classifyShellEffect("git push && gh pr create --dry-run")).toBe(
      "git_push",
    );
  });

  it("keeps the old refusals for each command in the line", () => {
    for (const command of [
      "cd x && gh pr create --dry-run",
      "cd x && gh pr create --web",
      "gh pr create --fill | tee out.log",
      "(cd x && gh pr create --fill)",
      "echo `gh pr create --fill`",
      "gh pr create --fill &",
      "echo 'git push && gh pr create'",
      "ls # later; gh pr create --fill",
      "cat <<EOF\ngh pr create --fill\nEOF",
    ]) {
      expect(classifyShellEffect(command), command).toBeUndefined();
    }
  });

  it("splits only where the shell runs one command after another", () => {
    expect(splitCommandList("a && b || c; d\ne \"f; g\" 'h && i'")).toEqual([
      "a ",
      " b ",
      " c",
      " d",
      "e \"f; g\" 'h && i'",
    ]);
    expect(splitCommandList("a 2>&1 && b")).toEqual(["a 2>&1 ", " b"]);
    expect(splitCommandList("a \\; b")).toEqual(["a \\; b"]);
    expect(splitCommandList("cat <<EOF; b\nc\nEOF")).toEqual([
      "cat <<EOF",
      " b",
    ]);
  });

  it("reads a command continued onto the next line", () => {
    expect(tokenizeSimpleCommand("git push \\\n  origin main")).toEqual([
      "git",
      "push",
      "origin",
      "main",
    ]);
    expect(classifyShellEffect("gh pr create \\\n  --fill")).toBe("pr_open");
    expect(classifyShellEffect("gh \\\n pr create --fill")).toBe("pr_open");
  });

  it("keeps the whole line as the target", () => {
    expect(
      classifyTool("Bash", { command: "git push && gh pr create --fill" }),
    ).toMatchObject({
      effect_kind: "pr_open",
      tool_target: "git push && gh pr create --fill",
    });
  });
});

describe("pull request detection by MCP tool name", () => {
  it("accepts the names GitHub servers give the tool", () => {
    for (const name of [
      "mcp__github__create_pull_request",
      "mcp__gh__github_create_pull_request",
      "mcp__github__createPullRequest",
      "mcp__github__CreatePullRequest",
      "mcp__github__pull_request_create",
      "mcp__github__create-pull-request",
      "MCP:create_pull_request",
      "MCP:createPullRequest",
    ]) {
      expect(classifyTool(name, {}).effect_kind, name).toBe("pr_open");
    }
  });

  it("does not take a name that does something else to a pull request", () => {
    for (const name of [
      "mcp__github__create_pull_request_review",
      "mcp__github__update_pull_request",
      "mcp__github__list_pull_requests",
      "mcp__github__get_pull_request",
      "mcp__github__createpullrequest",
    ]) {
      expect(classifyTool(name, {}).effect_kind, name).toBe("network");
    }
  });
});

describe("pull request attrs from a tool response", () => {
  it("reads the URL gh prints on stdout", () => {
    expect(
      pullRequestAttrs({
        stdout: "https://github.com/oxagen/oxagen/pull/3822\n",
        stderr:
          "remote: Create a pull request for 'b' on GitHub by visiting:\nremote: https://github.com/oxagen/oxagen/pull/new/b\n",
        interrupted: false,
      }),
    ).toEqual({
      "pr.url": "https://github.com/oxagen/oxagen/pull/3822",
      "pr.number": "3822",
      "pr.repository": "oxagen/oxagen",
    });
  });

  it("reads an MCP server's JSON and plain text", () => {
    expect(
      pullRequestAttrs({
        number: 7,
        html_url: "https://github.com/acme/web.app/pull/7",
      }),
    ).toMatchObject({ "pr.number": "7", "pr.repository": "acme/web.app" });
    expect(
      pullRequestAttrs("Created https://github.com/a/b/pull/12 for you"),
    ).toMatchObject({ "pr.url": "https://github.com/a/b/pull/12" });
  });

  it("answers nothing for a response that names no pull request", () => {
    expect(pullRequestAttrs(undefined)).toEqual({});
    expect(pullRequestAttrs({ stdout: "" })).toEqual({});
    expect(
      pullRequestAttrs({
        stderr: "remote: https://github.com/a/b/pull/new/branch",
      }),
    ).toEqual({});
  });
});

describe("tool targets are cut on a code point", () => {
  it("never leaves half of a surrogate pair at the end", () => {
    // 511 ASCII units, then an emoji whose two halves sit at 511 and 512.
    const command = `echo ${"x".repeat(506)}😀tail`;
    const target = classifyTool("Bash", { command }).tool_target as string;
    expect(target.length).toBe(511);
    expect(target.endsWith("x")).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(target)).toBe(false);
    const whole = `echo ${"x".repeat(505)}😀tail`;
    const kept = classifyTool("Bash", { command: whole }).tool_target as string;
    expect(kept.length).toBe(512);
    expect(kept.endsWith("😀")).toBe(true);
  });
});
