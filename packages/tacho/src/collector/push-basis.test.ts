import { describe, expect, it } from "vitest";
import type { ExecResult } from "../host/service";
import { gitPushTarget, pushCredentialBasis } from "./push-basis";

const PROXY = "http://127.0.0.1:47111/github/acme/app.git";
const RECEIPT = {
  cwd: "/repo",
  repository: "acme/app",
  url: PROXY,
  helper: "!tacho github credential",
  remotes: [
    {
      key: "remote.origin.url",
      before: ["https://github.com/acme/app.git"],
      after: [PROXY],
    },
  ],
};

/** A fake Git: `answers` maps the arguments after `-C <dir>` to stdout. */
function git(answers: Record<string, string>) {
  const calls: string[][] = [];
  const execAsync = async (
    _command: string,
    args: string[],
  ): Promise<ExecResult> => {
    calls.push(args);
    const answer = answers[args.slice(2).join(" ")];
    return answer === undefined
      ? { status: 1, stdout: "", stderr: "" }
      : { status: 0, stdout: `${answer}\n`, stderr: "" };
  };
  return { execAsync, calls };
}

const ORIGIN_IS_PROXY = {
  "remote get-url --push --all origin": PROXY,
};

describe("gitPushTarget", () => {
  it("reads the remote past push options", () => {
    expect(gitPushTarget("git push -u origin main")).toEqual({
      chdir: [],
      remote: "origin",
    });
    expect(
      gitPushTarget("git push -o ci.skip --force-with-lease fork"),
    ).toEqual({ chdir: [], remote: "fork" });
    expect(gitPushTarget("git push --repo=fork")).toEqual({
      chdir: [],
      remote: "fork",
    });
    expect(gitPushTarget("git push")).toEqual({ chdir: [] });
  });

  it("follows -C and refuses options that redirect the push", () => {
    expect(gitPushTarget("git -C sub push origin")).toEqual({
      chdir: ["sub"],
      remote: "origin",
    });
    expect(gitPushTarget("git -c remote.origin.url=x push")).toBeUndefined();
    expect(gitPushTarget("git --git-dir=/x push")).toBeUndefined();
    expect(gitPushTarget("git status")).toBeUndefined();
  });
});

describe("pushCredentialBasis", () => {
  it("is gateway_brokered when every push URL is the receipt's proxy", async () => {
    const { execAsync } = git(ORIGIN_IS_PROXY);
    await expect(
      pushCredentialBasis("git push origin main", "/repo", {
        receipts: () => [RECEIPT],
        execAsync,
      }),
    ).resolves.toBe("gateway_brokered");
  });

  it("finds Git's default remote when the command names none", async () => {
    const { execAsync } = git({
      "symbolic-ref --short HEAD": "main",
      "config --get branch.main.remote": "origin",
      ...ORIGIN_IS_PROXY,
    });
    await expect(
      pushCredentialBasis("git push", "/repo", {
        receipts: () => [RECEIPT],
        execAsync,
      }),
    ).resolves.toBe("gateway_brokered");
  });

  it("is harness_held for a remote edited back to GitHub after configure", async () => {
    // The receipt still names the proxy. Git's answer is what counts.
    const { execAsync } = git({
      "remote get-url --push --all origin": "https://github.com/acme/app.git",
    });
    await expect(
      pushCredentialBasis("git push origin", "/repo", {
        receipts: () => [RECEIPT],
        execAsync,
      }),
    ).resolves.toBe("harness_held");
  });

  it("is harness_held when one of several push URLs bypasses the proxy", async () => {
    const { execAsync } = git({
      "remote get-url --push --all origin": `${PROXY}\ngit@github.com:acme/app.git`,
    });
    await expect(
      pushCredentialBasis("git push origin", "/repo", {
        receipts: () => [RECEIPT],
        execAsync,
      }),
    ).resolves.toBe("harness_held");
  });

  it("is harness_held for a URL with a token in it", async () => {
    const { execAsync } = git(ORIGIN_IS_PROXY);
    await expect(
      pushCredentialBasis(
        "git push https://x-access-token:ghp_x@github.com/acme/app.git",
        "/repo",
        { receipts: () => [RECEIPT], execAsync },
      ),
    ).resolves.toBe("harness_held");
  });

  it("is harness_held outside a configured directory and asks Git nothing", async () => {
    const { execAsync, calls } = git(ORIGIN_IS_PROXY);
    await expect(
      pushCredentialBasis("git push origin", "/elsewhere", {
        receipts: () => [RECEIPT],
        execAsync,
      }),
    ).resolves.toBe("harness_held");
    await expect(
      pushCredentialBasis("git push origin", "/repo", {
        receipts: () => [],
        execAsync,
      }),
    ).resolves.toBe("harness_held");
    expect(calls).toEqual([]);
  });

  it("resolves -C against the session's directory", async () => {
    const { execAsync, calls } = git(ORIGIN_IS_PROXY);
    await expect(
      pushCredentialBasis("git -C ../repo push origin", "/other", {
        receipts: () => [RECEIPT],
        execAsync,
      }),
    ).resolves.toBe("gateway_brokered");
    expect(calls[0]?.slice(0, 2)).toEqual(["-C", "/repo"]);
  });
});
