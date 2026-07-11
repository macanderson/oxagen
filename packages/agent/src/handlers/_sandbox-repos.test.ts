import { describe, expect, it } from "vitest";
import {
  composeRepoCloneScript,
  resolveRepoDirs,
  type SessionRepoRef,
} from "./_sandbox-repos";

describe("resolveRepoDirs", () => {
  it("uses the bare repo name when there is no collision", () => {
    expect(
      resolveRepoDirs([
        { owner: "acme", repo: "api" },
        { owner: "acme", repo: "web" },
      ]),
    ).toEqual(["api", "web"]);
  });

  it("suffixes a same-named repo with -<owner>", () => {
    expect(
      resolveRepoDirs([
        { owner: "acme", repo: "api" },
        { owner: "globex", repo: "api" },
      ]),
    ).toEqual(["api", "api-globex"]);
  });

  it("adds a numeric suffix for a pathological double collision", () => {
    // Same owner + repo twice: the -<owner> suffix would still collide, so the
    // resolver falls back to a numeric suffix to stay total and unique.
    expect(
      resolveRepoDirs([
        { owner: "acme", repo: "api" },
        { owner: "acme", repo: "api" },
        { owner: "acme", repo: "api" },
      ]),
    ).toEqual(["api", "api-acme", "api-acme-2"]);
  });
});

describe("composeRepoCloneScript", () => {
  it("returns an empty string when there are no repos", () => {
    expect(composeRepoCloneScript([], { hasToken: false })).toBe("");
    expect(composeRepoCloneScript([], { hasToken: true })).toBe("");
  });

  it("clones a single PUBLIC repo over anonymous HTTPS (no token reference)", () => {
    const script = composeRepoCloneScript([{ owner: "acme", repo: "api" }], {
      hasToken: false,
    });
    expect(script).toContain("mkdir -p /workspace");
    expect(script).toContain(
      "git clone 'https://github.com/acme/api.git' '/workspace/api'",
    );
    // No token channel referenced for a public clone.
    expect(script).not.toContain("GITHUB_TOKEN");
    expect(script).not.toContain("x-access-token");
    // Origin scrubbed to a token-free URL.
    expect(script).toContain(
      "git -C '/workspace/api' remote set-url origin 'https://github.com/acme/api.git'",
    );
  });

  it("clones a PRIVATE repo referencing $GITHUB_TOKEN literally — never a token value", () => {
    const script = composeRepoCloneScript([{ owner: "acme", repo: "api" }], {
      hasToken: true,
    });
    // The literal env reference is present, expanded by the shell at runtime.
    expect(script).toContain(
      'git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/acme/api.git" \'/workspace/api\'',
    );
    // The composer never receives a token, so no ghs_/ghp_/gho_ value can appear.
    expect(script).not.toMatch(/gh[a-z]_/);
    // Origin is rewritten to a token-free URL so the credential never persists.
    expect(script).toContain(
      "git -C '/workspace/api' remote set-url origin 'https://github.com/acme/api.git'",
    );
    // The token-bearing URL must NOT survive as the origin.
    expect(script).not.toContain(
      "remote set-url origin \"https://x-access-token",
    );
  });

  it("pins a branch with --branch --single-branch when one is given", () => {
    const script = composeRepoCloneScript(
      [{ owner: "acme", repo: "api", branch: "release/v2" }],
      { hasToken: false },
    );
    expect(script).toContain(
      "git clone --branch 'release/v2' --single-branch 'https://github.com/acme/api.git' '/workspace/api'",
    );
  });

  it("omits branch flags when no branch is given", () => {
    const script = composeRepoCloneScript([{ owner: "acme", repo: "api" }], {
      hasToken: false,
    });
    expect(script).not.toContain("--single-branch");
    expect(script).not.toContain("--branch");
  });

  it("clones multiple repos and suffixes a name collision by owner", () => {
    const repos: SessionRepoRef[] = [
      { owner: "acme", repo: "api", branch: "main" },
      { owner: "globex", repo: "api" },
    ];
    const script = composeRepoCloneScript(repos, { hasToken: true });
    expect(script).toContain("'/workspace/api'");
    expect(script).toContain("'/workspace/api-globex'");
    // Two clones + two scrubs + the mkdir, all joined by &&.
    expect(script.match(/git clone/g)).toHaveLength(2);
    expect(script.match(/remote set-url origin/g)).toHaveLength(2);
  });

  it("joins every step with && so any clone failure short-circuits and exits non-zero", () => {
    const script = composeRepoCloneScript(
      [
        { owner: "acme", repo: "api" },
        { owner: "acme", repo: "web" },
      ],
      { hasToken: false },
    );
    // The whole chain is a single && sequence: a failed clone stops the rest.
    expect(script.startsWith("mkdir -p /workspace && ")).toBe(true);
    expect(script).not.toContain(";"); // no unchained statement separators
    // mkdir + (clone+scrub)*2 = 5 steps → 4 joiners.
    expect(script.split(" && ")).toHaveLength(5);
  });

  it("single-quotes the clone target path and branch (shell-safety, defense in depth)", () => {
    const script = composeRepoCloneScript(
      [{ owner: "acme", repo: "api", branch: "feature/x" }],
      { hasToken: false },
    );
    expect(script).toContain("'/workspace/api'");
    expect(script).toContain("'feature/x'");
  });
});
