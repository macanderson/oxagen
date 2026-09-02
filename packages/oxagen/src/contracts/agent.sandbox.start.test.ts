import { describe, expect, it } from "vitest";
import { agentSandboxStart } from "./agent.sandbox.start";
import { getCapability } from "../registry";

describe("agent.sandbox.start capability", () => {
  it("is registered with the durable-session metadata", () => {
    const cap = getCapability("start_sandbox");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("agent");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies durable defaults when only nothing is supplied", () => {
    const parsed = agentSandboxStart.input.parse({});
    expect(parsed.image).toBe("agent");
    expect(parsed.memoryMb).toBe(2048);
    expect(parsed.ttlSeconds).toBe(86_400);
    expect(parsed.idleTimeoutSeconds).toBe(1_200);
    expect(parsed.network).toBe("allow");
  });

  it("accepts each image flavor", () => {
    for (const image of ["node", "python", "shell", "agent"] as const) {
      expect(agentSandboxStart.input.parse({ image }).image).toBe(image);
    }
  });

  it("rejects an unknown image", () => {
    expect(() => agentSandboxStart.input.parse({ image: "ruby" })).toThrow();
  });

  it("caps ttlSeconds at 24h", () => {
    expect(() =>
      agentSandboxStart.input.parse({ ttlSeconds: 90_000 }),
    ).toThrow();
    expect(
      agentSandboxStart.input.parse({ ttlSeconds: 86_400 }).ttlSeconds,
    ).toBe(86_400);
  });

  it("rejects an empty sessionKey but accepts a real one", () => {
    expect(() => agentSandboxStart.input.parse({ sessionKey: "" })).toThrow();
    expect(
      agentSandboxStart.input.parse({ sessionKey: "conv_42" }).sessionKey,
    ).toBe("conv_42");
  });

  it("validates the output shape", () => {
    const out = agentSandboxStart.output.parse({
      sessionId: "sbx_abc",
      status: "running",
      image: "agent",
      createdAt: new Date().toISOString(),
      reused: false,
    });
    expect(out.sessionId).toBe("sbx_abc");
    expect(out.reused).toBe(false);
  });
});

describe("start_sandbox capability — repos[] validation", () => {
  it("parses input without repos (repos is optional)", () => {
    const parsed = agentSandboxStart.input.parse({ image: "agent" });
    expect(parsed.repos).toBeUndefined();
  });

  it("parses a single repo without a branch", () => {
    const parsed = agentSandboxStart.input.parse({
      repos: [{ owner: "acme", repo: "api" }],
    });
    expect(parsed.repos).toEqual([{ owner: "acme", repo: "api" }]);
  });

  it("parses repos with a pinned branch and multiple entries", () => {
    const parsed = agentSandboxStart.input.parse({
      repos: [
        { owner: "acme", repo: "api", branch: "release/v2" },
        { owner: "globex", repo: "web" },
      ],
    });
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos![0]!.branch).toBe("release/v2");
  });

  it("accepts a dotted repo name like .github", () => {
    const parsed = agentSandboxStart.input.parse({
      repos: [{ owner: "acme", repo: ".github" }],
    });
    expect(parsed.repos![0]!.repo).toBe(".github");
  });

  it("rejects more than 8 repos", () => {
    const repos = Array.from({ length: 9 }, (_, i) => ({
      owner: "acme",
      repo: `r${i}`,
    }));
    expect(() => agentSandboxStart.input.parse({ repos })).toThrow();
  });

  // ── Injection defense: owner / repo charset ──────────────────────────────
  const BAD_SEGMENTS = [
    "a b", // whitespace
    "a/b", // path separator
    "a;rm -rf", // command chain
    "a$b", // expansion
    "a&b", // background
    "a|b", // pipe
    "a`b`", // command substitution (backtick)
    "a>b", // redirect
    "a'b", // quote break-out
    'a"b', // quote break-out
    "a\\b", // backslash
    "..", // path traversal
    ".", // current dir
  ];
  for (const bad of BAD_SEGMENTS) {
    it(`rejects an unsafe owner ${JSON.stringify(bad)}`, () => {
      expect(() =>
        agentSandboxStart.input.parse({ repos: [{ owner: bad, repo: "api" }] }),
      ).toThrow();
    });
    it(`rejects an unsafe repo ${JSON.stringify(bad)}`, () => {
      expect(() =>
        agentSandboxStart.input.parse({
          repos: [{ owner: "acme", repo: bad }],
        }),
      ).toThrow();
    });
  }

  // ── Injection defense: branch charset ────────────────────────────────────
  const BAD_BRANCHES = [
    "has space",
    "has\ttab",
    "has\nnewline",
    "with`backtick`",
    "with$dollar",
    "with;semicolon",
    "with&amp",
    "with|pipe",
    "with<lt",
    "with>gt",
    'with"dquote',
    "with'squote",
    "with\\backslash",
    "-leadingdash", // could be read as a git flag
  ];
  for (const branch of BAD_BRANCHES) {
    it(`rejects an unsafe branch ${JSON.stringify(branch)}`, () => {
      expect(() =>
        agentSandboxStart.input.parse({
          repos: [{ owner: "acme", repo: "api", branch }],
        }),
      ).toThrow();
    });
  }

  it("accepts a safe slashed branch name", () => {
    const parsed = agentSandboxStart.input.parse({
      repos: [{ owner: "acme", repo: "api", branch: "feature/thing-2.0" }],
    });
    expect(parsed.repos![0]!.branch).toBe("feature/thing-2.0");
  });

  it("enforces owner/repo length caps", () => {
    expect(() =>
      agentSandboxStart.input.parse({
        repos: [{ owner: "a".repeat(101), repo: "api" }],
      }),
    ).toThrow();
    expect(() =>
      agentSandboxStart.input.parse({
        repos: [{ owner: "acme", repo: "a".repeat(201) }],
      }),
    ).toThrow();
  });
});
