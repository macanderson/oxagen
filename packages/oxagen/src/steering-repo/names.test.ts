import { describe, expect, it } from "vitest";
import {
  BRANCH_PREFIXES,
  branchPrefixOf,
  BUILTIN_SERVER,
  CODE_REPOSITORY_CHECK_NAME,
  CREDENTIAL_REF_PREFIX,
  credentialRef,
  findMentions,
  isLineage,
  MENTION_KINDS,
  mentionText,
  ORGANIZATION_REPO_NAME,
  parseCredentialRef,
  parseToolRef,
  REPO_REF_PATTERN,
  repoRef,
  REQUIRED_CHECK_NAME,
  STEERING_DEFAULT_BRANCH,
  STEERING_ENVIRONMENT,
  STEERING_REPO_NAME_PREFIX,
  steeringRepoName,
  TOOL_NAME_MAX,
  TOOL_NAME_PATTERN,
  TOOL_REF_PATTERN,
  TOOL_SEPARATOR,
  TOOL_TARGET_PATTERN,
  toolName,
  toolTargetMatches,
} from "./names";

describe("fixed names", () => {
  it("holds the names the Shared contract fixes", () => {
    expect(REQUIRED_CHECK_NAME).toBe("Oxagen steering");
    expect(CODE_REPOSITORY_CHECK_NAME).toBe("Oxagen");
    expect(STEERING_ENVIRONMENT).toBe("steering");
    expect(STEERING_DEFAULT_BRANCH).toBe("main");
    expect(ORGANIZATION_REPO_NAME).toBe("oxagen");
    expect(STEERING_REPO_NAME_PREFIX).toBe("oxagen-");
    expect(TOOL_SEPARATOR).toBe("__");
    expect(BUILTIN_SERVER).toBe("builtin");
    expect(TOOL_NAME_MAX).toBe(64);
    expect(CREDENTIAL_REF_PREFIX).toBe("oxagen:credential/");
    expect(MENTION_KINDS).toEqual(["record", "skill", "tool"]);
  });
});

describe("steeringRepoName", () => {
  it("names the first repo oxagen-<slug>", () => {
    expect(steeringRepoName("core-platform")).toBe("oxagen-core-platform");
    expect(steeringRepoName("core-platform", 1)).toBe("oxagen-core-platform");
  });

  it("adds the attempt number when the name is taken", () => {
    expect(steeringRepoName("core-platform", 2)).toBe("oxagen-core-platform-2");
    expect(steeringRepoName("billing7", 13)).toBe("oxagen-billing7-13");
  });

  it.each(["Core", "core--platform", "-core", "core-", "core_platform", ""])(
    "refuses the slug %j",
    (slug) => {
      expect(() => steeringRepoName(slug)).toThrow(RangeError);
      expect(() => steeringRepoName(slug)).toThrow("is not a workspace slug");
    },
  );

  it.each([0, -1, 1.5, Number.NaN])("refuses the attempt number %s", (n) => {
    expect(() => steeringRepoName("core", n)).toThrow(RangeError);
    expect(() => steeringRepoName("core", n)).toThrow(
      `the attempt number is a whole number from 1, not ${n}`,
    );
  });
});

describe("branchPrefixOf", () => {
  it("lists the prefixes in the spec's order", () => {
    expect(BRANCH_PREFIXES).toEqual([
      "steering",
      "memory",
      "tools",
      "agents",
      "policy",
      "workspace",
    ]);
  });

  it.each([
    ["steering/add-refund-rule", "steering"],
    ["memory/2026-09-26", "memory"],
    ["tools/import-stripe", "tools"],
    ["agents/ci-reviewer", "agents"],
    ["policy/refund-limit", "policy"],
    ["workspace/budget", "workspace"],
    ["steering/a/b", "steering"],
  ])("reads %s as %s", (branch, prefix) => {
    expect(branchPrefixOf(branch)).toBe(prefix);
  });

  it.each(["steering/", "steering", "feature/x", "steeringx/y", "main", ""])(
    "finds no prefix in %j",
    (branch) => {
      expect(branchPrefixOf(branch)).toBeNull();
    },
  );
});

describe("toolName", () => {
  it("joins a server and a tool key", () => {
    expect(toolName("billing", "create_refund")).toBe("billing__create_refund");
    expect(toolName(BUILTIN_SERVER, "read_file")).toBe("builtin__read_file");
  });

  it("accepts a name of exactly 64 characters", () => {
    const name = toolName("a".repeat(24), "b".repeat(38));
    expect(name).toHaveLength(64);
    expect(TOOL_NAME_PATTERN.test(name)).toBe(true);
  });

  it("refuses a name of 65 characters", () => {
    expect(() => toolName("a".repeat(24), "b".repeat(39))).toThrow(
      `${"a".repeat(24)}__${"b".repeat(39)} is 65 characters. A tool name is at most 64.`,
    );
  });

  it.each(["Billing", "1billing", "_billing", "a".repeat(25), "bil-ling", ""])(
    "refuses the server name %j",
    (server) => {
      expect(() => toolName(server, "create_refund")).toThrow(RangeError);
      expect(() => toolName(server, "create_refund")).toThrow(
        `"${server}" is not a server name.`,
      );
    },
  );

  it.each(["Create", "1create", "_create", "create-refund", ""])(
    "refuses the tool key %j",
    (tool) => {
      expect(() => toolName("billing", tool)).toThrow(RangeError);
      expect(() => toolName("billing", tool)).toThrow(
        `"${tool}" is not a tool key.`,
      );
    },
  );
});

describe("parseToolRef", () => {
  it("reads an unpinned tool name", () => {
    expect(parseToolRef("billing__create_refund")).toEqual({
      server: "billing",
      tool: "create_refund",
      version: null,
    });
  });

  it("reads a pinned reference", () => {
    expect(parseToolRef("billing__create_refund@3")).toEqual({
      server: "billing",
      tool: "create_refund",
      version: 3,
    });
    expect(parseToolRef("stripe__list_charges@123456789")?.version).toBe(
      123456789,
    );
  });

  it("splits at the first separator", () => {
    expect(parseToolRef("a__b__c")).toEqual({
      server: "a",
      tool: "b__c",
      version: null,
    });
  });

  it.each([
    "billing__create_refund@0",
    "billing__create_refund@01",
    "billing__create_refund@1234567890",
    "billing__create_refund@",
    "billing__*",
    "Billing__create_refund",
    "billing_create_refund",
    "billing__",
    `${"a".repeat(24)}__${"b".repeat(39)}`,
    `${"a".repeat(24)}__${"b".repeat(39)}@1`,
    "",
  ])("refuses %j", (ref) => {
    expect(parseToolRef(ref)).toBeNull();
    expect(TOOL_REF_PATTERN.test(ref)).toBe(false);
  });
});

describe("toolTargetMatches", () => {
  it("matches every tool of a server for <server>__*", () => {
    expect(toolTargetMatches("billing__*", "billing__create_refund")).toBe(true);
    expect(toolTargetMatches("billing__*", "billing__list_refunds")).toBe(true);
  });

  it("does not match another server that shares the prefix", () => {
    expect(toolTargetMatches("billing__*", "billingx__create_refund")).toBe(
      false,
    );
    expect(toolTargetMatches("billing__*", "stripe__list_charges")).toBe(false);
  });

  it("matches a named tool only by equality", () => {
    expect(
      toolTargetMatches("stripe__list_charges", "stripe__list_charges"),
    ).toBe(true);
    expect(toolTargetMatches("stripe__list_charges", "stripe__refund")).toBe(
      false,
    );
    expect(
      toolTargetMatches("stripe__list", "stripe__list_charges"),
    ).toBe(false);
  });

  it("agrees with the target pattern", () => {
    expect(TOOL_TARGET_PATTERN.test("billing__*")).toBe(true);
    expect(TOOL_TARGET_PATTERN.test("billing__create_refund")).toBe(true);
    expect(TOOL_TARGET_PATTERN.test("billing*")).toBe(false);
    expect(TOOL_TARGET_PATTERN.test("*__create_refund")).toBe(false);
    expect(TOOL_TARGET_PATTERN.test("billing__create*")).toBe(false);
  });
});

describe("credentialRef", () => {
  it("builds oxagen:credential/<name>", () => {
    expect(credentialRef("stripe-live")).toBe("oxagen:credential/stripe-live");
    expect(credentialRef("7")).toBe("oxagen:credential/7");
    expect(credentialRef("a".repeat(63))).toBe(
      `oxagen:credential/${"a".repeat(63)}`,
    );
  });

  it.each(["Stripe", "-stripe", "stripe_live", "a".repeat(64), ""])(
    "refuses the name %j",
    (name) => {
      expect(() => credentialRef(name)).toThrow(RangeError);
      expect(() => credentialRef(name)).toThrow(
        `"${name}" is not a credential name.`,
      );
    },
  );

  it("reads the name back", () => {
    expect(parseCredentialRef("oxagen:credential/stripe-live")).toBe(
      "stripe-live",
    );
    expect(parseCredentialRef(credentialRef("embeddings"))).toBe("embeddings");
  });

  it.each([
    "oxagen:credential/",
    "credential/stripe-live",
    "oxagen:credential/Stripe",
    "oxagen:secret/stripe-live",
    "stripe-live",
  ])("finds no name in %j", (ref) => {
    expect(parseCredentialRef(ref)).toBeNull();
  });
});

describe("repoRef", () => {
  it("builds a lowercase <host>/<owner>/<name>", () => {
    expect(repoRef("github.com", "a-intel", "platform")).toBe(
      "github.com/a-intel/platform",
    );
    expect(repoRef("GitHub.com", "A-Intel", "Platform")).toBe(
      "github.com/a-intel/platform",
    );
  });

  it("accepts a GitLab subgroup and dotted names", () => {
    expect(repoRef("gitlab.com", "group/subgroup", "repo")).toBe(
      "gitlab.com/group/subgroup/repo",
    );
    expect(repoRef("git.example.co.uk", "team", "my.repo_2")).toBe(
      "git.example.co.uk/team/my.repo_2",
    );
    expect(repoRef("github.com", "a-intel", ".github")).toBe(
      "github.com/a-intel/.github",
    );
  });

  it.each([
    ["localhost", "a-intel", "platform"],
    ["github.com", "", "platform"],
    ["github.com", "..", "platform"],
    ["github.com", "a-intel", "."],
    ["github.com", "a-intel", ".."],
    ["github.com", "a-intel", "my repo"],
    ["github.com", "a-intel/", "platform"],
  ])("refuses %s/%s/%s", (host, owner, name) => {
    const ref = `${host}/${owner}/${name}`.toLowerCase();
    expect(() => repoRef(host, owner, name)).toThrow(RangeError);
    expect(() => repoRef(host, owner, name)).toThrow(
      `${ref} is not a repository reference.`,
    );
  });

  it("needs an owner and a name after the host", () => {
    expect(REPO_REF_PATTERN.test("github.com/a-intel")).toBe(false);
    expect(REPO_REF_PATTERN.test("github.com/a-intel/platform")).toBe(true);
  });
});

describe("findMentions", () => {
  it("finds each kind of mention in order, with its offset", () => {
    const body =
      "Follow @record:a-intel.platform.no-push-to-main, call @tool:billing__create_refund, and read @skill:a-intel.brand.voice.";
    expect(findMentions(body)).toEqual([
      {
        kind: "record",
        target: "a-intel.platform.no-push-to-main",
        index: body.indexOf("@record:"),
      },
      {
        kind: "tool",
        target: "billing__create_refund",
        index: body.indexOf("@tool:"),
      },
      {
        kind: "skill",
        target: "a-intel.brand.voice",
        index: body.indexOf("@skill:"),
      },
    ]);
  });

  it("finds mentions inside code spans", () => {
    expect(findMentions("Run `@tool:stripe__list_charges` first.")).toEqual([
      { kind: "tool", target: "stripe__list_charges", index: 5 },
    ]);
  });

  it("finds nothing without a known kind or a target of two characters", () => {
    expect(findMentions("")).toEqual([]);
    expect(findMentions("Ask @dana or @user:abc.")).toEqual([]);
    expect(findMentions("@tool:x and @record:")).toEqual([]);
  });

  it("writes a mention back as text", () => {
    expect(mentionText("tool", "billing__create_refund")).toBe(
      "@tool:billing__create_refund",
    );
    const text = mentionText("record", "a-intel.billing.refunds-over-100");
    expect(findMentions(text)).toEqual([
      { kind: "record", target: "a-intel.billing.refunds-over-100", index: 0 },
    ]);
  });
});

describe("isLineage", () => {
  it.each([
    ["a-intel.platform.no-push-to-main", true],
    ["ab", true],
    ["a1.b2", true],
    ["a", false],
    ["A-intel.platform", false],
    ["a-intel.", false],
    [".a-intel", false],
    ["a_intel", false],
    ["", false],
  ])("reads %j as %s", (value, expected) => {
    expect(isLineage(value)).toBe(expected);
  });
});
