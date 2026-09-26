import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { RESERVED_WORKSPACE_SLUGS } from "../workspace-slug";
import {
  actorSchema,
  credentialRefSchema,
  frameRefSchema,
  gitObjectIdSchema,
  instantSchema,
  lineageSchema,
  organizationSlugSchema,
  recordIdSchema,
  repoPathSchema,
  repoRefSchema,
  runIdSchema,
  sha256Schema,
  toolNameSchema,
  toolRefSchema,
  toolTargetSchema,
  workspaceSlugSchema,
} from "./common";
import { toJsonSchema } from "./json-schema";

/** The messages a schema reports for a value, or none when it accepts it. */
function messages(schema: z.ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

function accepts(schema: z.ZodTypeAny, value: unknown): boolean {
  return schema.safeParse(value).success;
}

const HEX_40 = "0123456789abcdef0123456789abcdef01234567";
const HEX_64 = `${HEX_40}0123456789abcdef01234567`;

describe("every shared schema", () => {
  it.each([
    ["lineage", lineageSchema],
    ["repository", repoRefSchema],
    ["credential", credentialRefSchema],
    ["tool name", toolNameSchema],
    ["tool target", toolTargetSchema],
    ["tool reference", toolRefSchema],
    ["record id", recordIdSchema],
    ["sha256", sha256Schema],
    ["git object id", gitObjectIdSchema],
    ["instant", instantSchema],
    ["organization slug", organizationSlugSchema],
    ["workspace slug", workspaceSlugSchema],
    ["run id", runIdSchema],
    ["frame reference", frameRefSchema],
    ["repository path", repoPathSchema],
    ["actor", actorSchema],
  ])("refuses a value that is not a string for the %s", (_label, schema) => {
    expect(accepts(schema, 42)).toBe(false);
    expect(accepts(schema, null)).toBe(false);
    expect(accepts(schema, undefined)).toBe(false);
  });
});

describe("lineageSchema", () => {
  it.each(["a-intel.core.ci-reviewer", "ab", "a1", "7.x"])(
    "accepts %j",
    (value) => {
      expect(accepts(lineageSchema, value)).toBe(true);
    },
  );

  it.each(["a", "", "-ab", "ab-", "ab.", ".ab", "A-b", "a_b", "a b"])(
    "refuses %j with the lineage message",
    (value) => {
      expect(messages(lineageSchema, value)).toEqual([
        "a lineage is lowercase letters, digits, dots, and hyphens, and starts and ends with a letter or digit",
      ]);
    },
  );
});

describe("repoRefSchema", () => {
  it.each([
    "github.com/a-intel/platform",
    "gitlab.com/group/sub/repo",
    "git.example.co.uk/team/my.repo_2",
  ])("accepts %j", (value) => {
    expect(accepts(repoRefSchema, value)).toBe(true);
  });

  it.each([
    "github.com/a-intel",
    "GitHub.com/a-intel/platform",
    "localhost/a-intel/platform",
    "github.com/../platform",
    "github.com/a-intel/.",
    "github.com//platform",
    "",
  ])("refuses %j with the repository message", (value) => {
    expect(messages(repoRefSchema, value)).toEqual([
      "a repository is <host>/<owner>/<name> in lowercase, such as github.com/a-intel/platform",
    ]);
  });
});

describe("credentialRefSchema", () => {
  it.each(["oxagen:credential/stripe-live", "oxagen:credential/7"])(
    "accepts %j",
    (value) => {
      expect(accepts(credentialRefSchema, value)).toBe(true);
    },
  );

  it.each([
    "oxagen:credential/",
    "oxagen:credential/Stripe",
    "oxagen:credential/-stripe",
    "oxagen:credential/stripe_live",
    `oxagen:credential/${"a".repeat(64)}`,
    "credential/stripe-live",
  ])("refuses %j with the credential message", (value) => {
    expect(messages(credentialRefSchema, value)).toEqual([
      "a credential is oxagen:credential/<name>, the name in lowercase letters, digits, and hyphens",
    ]);
  });
});

describe("toolNameSchema", () => {
  const toolNameMessage =
    "a tool name is <server>__<tool> in lowercase letters, digits, and underscores, 64 characters at most";

  it.each(["stripe__list_charges", "a__b", `s__${"t".repeat(61)}`])(
    "accepts %j",
    (value) => {
      expect(accepts(toolNameSchema, value)).toBe(true);
    },
  );

  it.each(["billing__*", "Stripe__list", "stripe_list", "__list", "a__"])(
    "refuses %j with the tool name message",
    (value) => {
      expect(messages(toolNameSchema, value)).toEqual([toolNameMessage]);
    },
  );

  it("refuses a 65 character name on length and on pattern", () => {
    const result = toolNameSchema.safeParse(`s__${"t".repeat(62)}`);
    expect(result.success).toBe(false);
    if (result.success) return;
    const codes = result.error.issues.map((issue) => issue.code);
    expect(codes).toContain("too_big");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      toolNameMessage,
    );
  });
});

describe("toolTargetSchema", () => {
  it.each(["billing__*", "stripe__list_charges", "a__*"])(
    "accepts %j",
    (value) => {
      expect(accepts(toolTargetSchema, value)).toBe(true);
    },
  );

  it.each(["billing__x*", "billing__", "billing*", "__*", "Billing__*"])(
    "refuses %j with the tool target message",
    (value) => {
      expect(messages(toolTargetSchema, value)).toEqual([
        "a tool target is <server>__<tool> or <server>__*",
      ]);
    },
  );

  it("refuses a 65 character target on length", () => {
    const result = toolTargetSchema.safeParse(`s__${"t".repeat(62)}`);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.code)).toContain(
      "too_big",
    );
  });
});

describe("toolRefSchema", () => {
  it.each(["billing__create_refund", "billing__create_refund@3"])(
    "accepts %j",
    (value) => {
      expect(accepts(toolRefSchema, value)).toBe(true);
    },
  );

  it.each([
    "billing__create_refund@0",
    "billing__create_refund@",
    "billing__*",
    "billing",
  ])("refuses %j with the tool reference message", (value) => {
    expect(messages(toolRefSchema, value)).toEqual([
      "a tool reference is <server>__<tool>, optionally followed by @<version>",
    ]);
  });
});

describe("recordIdSchema", () => {
  it.each(["rec_refund_policy_0123456789ab", "rec_7_abcdef012345"])(
    "accepts %j",
    (value) => {
      expect(accepts(recordIdSchema, value)).toBe(true);
    },
  );

  it.each([
    "rec__0123456789ab",
    "rec_refund_0123456789AB",
    "rec_refund_0123456789a",
    "rec_Refund_0123456789ab",
    "record_refund_0123456789ab",
  ])("refuses %j", (value) => {
    expect(accepts(recordIdSchema, value)).toBe(false);
  });
});

describe("sha256Schema", () => {
  it("accepts sha256: and 64 lowercase hex characters", () => {
    expect(accepts(sha256Schema, `sha256:${HEX_64}`)).toBe(true);
  });

  it.each([
    `sha256:${HEX_64.slice(1)}`,
    `sha256:${HEX_64}0`,
    `sha256:${HEX_64.toUpperCase()}`,
    `sha1:${HEX_40}`,
    HEX_64,
  ])("refuses %j", (value) => {
    expect(accepts(sha256Schema, value)).toBe(false);
  });
});

describe("gitObjectIdSchema", () => {
  it.each([HEX_40, HEX_64])("accepts %j", (value) => {
    expect(accepts(gitObjectIdSchema, value)).toBe(true);
  });

  it.each([
    HEX_40.slice(1),
    `${HEX_40}0`,
    HEX_64.slice(1),
    `${HEX_64}0`,
    HEX_40.toUpperCase(),
  ])("refuses %j", (value) => {
    expect(accepts(gitObjectIdSchema, value)).toBe(false);
  });
});

describe("instantSchema", () => {
  it.each([
    "2026-09-26T10:00:00Z",
    "2026-09-26T10:00:00.123Z",
    "2026-09-26T10:00:00+02:00",
    "2026-09-26T10:00:00-05:30",
  ])("accepts %j", (value) => {
    expect(accepts(instantSchema, value)).toBe(true);
  });

  it.each(["2026-09-26", "2026-09-26T10:00:00", "yesterday", ""])(
    "refuses %j",
    (value) => {
      expect(accepts(instantSchema, value)).toBe(false);
    },
  );
});

describe("organizationSlugSchema", () => {
  it.each(["a-intel", "ab", "a--b", "a".repeat(40)])("accepts %j", (value) => {
    expect(accepts(organizationSlugSchema, value)).toBe(true);
  });

  it.each(["A-intel", "a_intel", "a intel"])(
    "refuses %j with the organization slug message",
    (value) => {
      expect(messages(organizationSlugSchema, value)).toEqual([
        "lowercase letters, digits, and hyphens only",
      ]);
    },
  );

  it.each([
    ["a", "too_small"],
    ["a".repeat(41), "too_big"],
  ])("refuses %j on length", (value, code) => {
    const result = organizationSlugSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.code)).toEqual([code]);
  });
});

describe("workspaceSlugSchema", () => {
  it.each(["core", "core-platform", "ws2"])("accepts %j", (value) => {
    expect(accepts(workspaceSlugSchema, value)).toBe(true);
  });

  it.each([...RESERVED_WORKSPACE_SLUGS])(
    "refuses the reserved route segment %j",
    (value) => {
      expect(messages(workspaceSlugSchema, value)).toEqual([
        "workspace slug is a reserved route segment",
      ]);
    },
  );

  it.each(["core--platform", "-core", "core-", "Core"])(
    "refuses %j with the workspace slug message",
    (value) => {
      expect(messages(workspaceSlugSchema, value)).toEqual([
        "lowercase letters and digits, separated by single hyphens",
      ]);
    },
  );

  it.each(["c", "c".repeat(41)])("refuses %j on length", (value) => {
    expect(accepts(workspaceSlugSchema, value)).toBe(false);
  });

  it("publishes the reserved segments as a not enum", () => {
    expect(toJsonSchema(workspaceSlugSchema)).toMatchObject({
      type: "string",
      minLength: 2,
      maxLength: 40,
      not: { enum: [...RESERVED_WORKSPACE_SLUGS] },
    });
  });
});

describe("runIdSchema and frameRefSchema", () => {
  it("accepts a run id and a frame of it", () => {
    expect(accepts(runIdSchema, "run_01K5QK7D")).toBe(true);
    expect(accepts(frameRefSchema, "frame:run_01K5QK7D/88")).toBe(true);
    expect(accepts(frameRefSchema, "frame:run_01K5QK7D/0")).toBe(true);
  });

  it.each(["run_", "run-01K5QK7D", "run_01-K5", "RUN_01K5", "01K5QK7D"])(
    "refuses the run id %j",
    (value) => {
      expect(accepts(runIdSchema, value)).toBe(false);
    },
  );

  it.each([
    "frame:run_01K5QK7D/",
    "frame:run_01K5QK7D",
    "run_01K5QK7D/88",
    "frame:run_01K5QK7D/8a",
    "frame:run_/88",
  ])("refuses the frame reference %j", (value) => {
    expect(accepts(frameRefSchema, value)).toBe(false);
  });
});

describe("repoPathSchema", () => {
  it.each([
    "README.md",
    ".github/workflows/x.yml",
    "a/.hidden",
    "a/..b",
    "steering/skills/a-intel.brand.voice/SKILL.md",
  ])("accepts %j", (value) => {
    expect(accepts(repoPathSchema, value)).toBe(true);
  });

  it.each([
    "",
    "/abs",
    "a/",
    "a//b",
    ".",
    "..",
    "./a",
    "../x",
    "a/../b",
    "a/./b",
    "a/.",
    "a/..",
    "a\nb",
  ])("refuses %j", (value) => {
    expect(accepts(repoPathSchema, value)).toBe(false);
  });
});

describe("actorSchema", () => {
  it.each([
    "platform-team",
    "oxagen",
    "mac.anderson",
    "a",
    "7_bot",
    "a".repeat(128),
  ])("accepts %j", (value) => {
    expect(accepts(actorSchema, value)).toBe(true);
  });

  it.each(["", "-x", ".x", "_x", "Mac", "a b", "a".repeat(129)])(
    "refuses %j",
    (value) => {
      expect(accepts(actorSchema, value)).toBe(false);
    },
  );
});
