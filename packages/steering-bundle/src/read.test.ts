import { describe, expect, it } from "vitest";
import { NotBuiltError } from "@oxagen/mcp-studio";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import {
  fixtureRepo,
  organizationFixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { buildBundle, type BundleIdentity } from "./build";
import {
  readSteering,
  RecordFileError,
  recordBodyReader,
  steeringReadInputSchema,
  steeringReadOutputSchema,
  type ReadFile,
} from "./read";
import type { BundleSource, Delivery } from "./render";
import { TreeReader, treeFromFiles } from "./tree";

// ── Fixture versions ─────────────────────────────────────────────────────────

/** MCP Studio's compile() stands here, so no server compiles and the tool manifest stays null. */
function refuseCompile(): never {
  throw new NotBuiltError("compile");
}

async function publish(
  files: ReadonlyMap<string, string>,
  identity: BundleIdentity,
  version: number,
  commit: string,
): Promise<Bundle> {
  const { bundle } = await buildBundle({
    identity,
    version,
    commit,
    published_at: "2026-09-24T10:00:30Z",
    reader: await TreeReader.open(treeFromFiles(files)),
    previous: null,
    compiler: refuseCompile,
  });
  return bundle;
}

const workspaceFiles = fixtureRepo();
const organizationFiles = organizationFixtureRepo();

const workspace = await publish(
  workspaceFiles,
  {
    repository: "github.com/a-intel/oxagen-core-platform",
    scope: "workspace",
    organization: "a-intel",
    workspace: "core-platform",
  },
  21,
  "b5518188b20ddf02f905fadeaa50d9976abdcc90",
);

const organization = await publish(
  organizationFiles,
  { repository: "github.com/a-intel/oxagen", scope: "organization", organization: "a-intel" },
  1,
  "0123456789abcdef0123456789abcdef01234567",
);

const both: Delivery = { workspace, organization };

/** A file reader over the fixture trees, one tree per source. A path the tree lacks throws. */
function readerOver(
  trees: Partial<Record<BundleSource, ReadonlyMap<string, string>>>,
): ReadFile {
  return async (source, _bundle, file) => {
    const text = trees[source]?.get(file.path);
    if (text === undefined) throw new Error(`The ${source} tree has no file at ${file.path}.`);
    return text;
  };
}

const fromFixtures = readerOver({ workspace: workspaceFiles, organization: organizationFiles });

function recordOf(bundle: Bundle, lineage: string): BundleRecord {
  const record = bundle.records.find((entry) => entry.lineage === lineage);
  if (record === undefined) throw new Error(`The fixture version has no record ${lineage}.`);
  return record;
}

const REFUND = "a-intel.domain.refund";
const REFUND_PATH = "steering/domain/a-intel.domain.refund.md";
/** The refund record's body as the file writes it, without the blank lines around it. */
const REFUND_STATEMENT = [
  "A refund returns money against one captured charge. Amounts are integers in",
  "cents.",
  "",
  "States: `pending`, `succeeded`, `failed`, `canceled`. Only `pending` can be",
  "canceled, with `@tool:billing__cancel_refund`.",
  "",
  "A refund belongs to one charge (`billing__get_charge`) and one customer.",
].join("\n");

const VOICE = "a-intel.brand.voice";
const VOICE_FOLDER = "steering/skills/a-intel.brand.voice/";
const WORDS_PATH = `${VOICE_FOLDER}words.md`;

const SECRETS = "a-intel.security.no-secrets-in-code";

/** A version whose tool manifest puts the billing server in search mode. */
function withBillingSearch(bundle: Bundle): Bundle {
  return {
    ...bundle,
    tools: {
      schema: "tool-manifest/v1",
      servers: [{ name: "billing", exposure: { mode: "search" } }],
    },
  };
}

// ── Input schema ─────────────────────────────────────────────────────────────

describe("steeringReadInputSchema", () => {
  it("accepts a lineage alone and a lineage with a file", () => {
    expect(steeringReadInputSchema.safeParse({ lineage: REFUND }).success).toBe(true);
    expect(steeringReadInputSchema.safeParse({ lineage: VOICE, file: "words.md" }).success).toBe(
      true,
    );
  });

  it("refuses a key it does not know", () => {
    expect(steeringReadInputSchema.safeParse({ lineage: REFUND, version: 3 }).success).toBe(false);
  });

  it("refuses an empty file", () => {
    expect(steeringReadInputSchema.safeParse({ lineage: VOICE, file: "" }).success).toBe(false);
  });

  it("accepts a file of 512 characters and refuses one of 513", () => {
    const at = (length: number) =>
      steeringReadInputSchema.safeParse({ lineage: VOICE, file: "a".repeat(length) }).success;
    expect(at(512)).toBe(true);
    expect(at(513)).toBe(false);
  });

  it("refuses a lineage with an underscore or a capital letter", () => {
    expect(steeringReadInputSchema.safeParse({ lineage: "a-intel.domain_refund" }).success).toBe(
      false,
    );
    expect(steeringReadInputSchema.safeParse({ lineage: "A-intel.domain.refund" }).success).toBe(
      false,
    );
  });
});

// ── Records ──────────────────────────────────────────────────────────────────

describe("readSteering for a record", () => {
  it("returns the record as a heading and its statement, with no frontmatter", async () => {
    const result = await readSteering(both, { lineage: REFUND }, fromFixtures);

    expect(result).toStrictEqual({
      found: true,
      output: {
        lineage: REFUND,
        label: "Refund",
        kind: "fact",
        source: "workspace",
        version: 21,
        path: REFUND_PATH,
        text: `### Refund\n${REFUND_STATEMENT.replace("@tool:billing__cancel_refund", "billing__cancel_refund")}\n`,
      },
    });
    if (!result.found) throw new Error("The refund record was not found.");
    expect(result.output.text.startsWith("### Refund\n")).toBe(true);
    expect(result.output.text).not.toContain("---");
    expect(result.output.text).not.toContain("schema: steering-record/v1");
    expect(steeringReadOutputSchema.parse(result.output)).toStrictEqual(result.output);
  });

  it("writes a tool mention as the tool's name when the version has no tool manifest", async () => {
    expect(workspace.tools).toBeNull();
    const result = await readSteering(both, { lineage: REFUND }, fromFixtures);

    if (!result.found) throw new Error("The refund record was not found.");
    expect(result.output.text).toContain("canceled, with `billing__cancel_refund`.");
    expect(result.output.text).not.toContain("@tool:");
  });

  it("writes a tool mention as the server's call tool when its server is in search mode", async () => {
    const delivery: Delivery = { workspace: withBillingSearch(workspace), organization };
    const result = await readSteering(delivery, { lineage: REFUND }, fromFixtures);

    if (!result.found) throw new Error("The refund record was not found.");
    expect(result.output.text).toBe(
      `### Refund\n${REFUND_STATEMENT.replace("@tool:billing__cancel_refund", "call billing__call with tool cancel_refund")}\n`,
    );
    expect(result.output.text).toContain(
      "canceled, with `call billing__call with tool cancel_refund`.",
    );
  });

  it("reads the record file by its path and blob from the version that holds it", async () => {
    const calls: Array<{ source: BundleSource; version: number; path: string; blob: string }> = [];
    const recording: ReadFile = async (source, bundle, file) => {
      calls.push({ source, version: bundle.version, path: file.path, blob: file.blob });
      return fromFixtures(source, bundle, file);
    };

    await readSteering(both, { lineage: REFUND }, recording);

    const record = recordOf(workspace, REFUND);
    expect(calls).toStrictEqual([
      { source: "workspace", version: 21, path: REFUND_PATH, blob: record.blob },
    ]);
  });

  it("reads an organization record when the workspace has none of that lineage", async () => {
    const result = await readSteering(both, { lineage: SECRETS }, fromFixtures);

    if (!result.found) throw new Error("The organization record was not found.");
    expect(result.output).toMatchObject({
      lineage: SECRETS,
      label: "No secrets in code",
      kind: "constraint",
      source: "organization",
      version: 1,
      path: "steering/security/a-intel.security.no-secrets-in-code.md",
    });
    expect(result.output.text.startsWith("### No secrets in code\n")).toBe(true);
  });

  it("prefers the workspace record over an organization record of the same lineage", async () => {
    const clone: Bundle = { ...workspace, version: 99 };
    const reader = readerOver({ workspace: workspaceFiles, organization: workspaceFiles });

    const result = await readSteering({ workspace, organization: clone }, { lineage: REFUND }, reader);

    if (!result.found) throw new Error("The refund record was not found.");
    expect(result.output.source).toBe("workspace");
    expect(result.output.version).toBe(21);
  });

  it("falls back to the organization record when the workspace has no published version", async () => {
    const clone: Bundle = { ...workspace, version: 99 };
    const reader = readerOver({ organization: workspaceFiles });

    const result = await readSteering(
      { workspace: null, organization: clone },
      { lineage: REFUND },
      reader,
    );

    if (!result.found) throw new Error("The refund record was not found.");
    expect(result.output.source).toBe("organization");
    expect(result.output.version).toBe(99);
  });

  it("misses with record_not_found for a lineage neither version holds", async () => {
    await expect(
      readSteering(both, { lineage: "a-intel.domain.chargeback" }, fromFixtures),
    ).resolves.toStrictEqual({ found: false, miss: "record_not_found" });
  });

  it("misses with record_not_found when neither version is published", async () => {
    await expect(
      readSteering({ workspace: null, organization: null }, { lineage: REFUND }, fromFixtures),
    ).resolves.toStrictEqual({ found: false, miss: "record_not_found" });
  });

  it("throws RecordFileError when the record file does not read as a record", async () => {
    const broken: ReadFile = async () => "not a record\n";

    await expect(readSteering(both, { lineage: REFUND }, broken)).rejects.toBeInstanceOf(
      RecordFileError,
    );
  });
});

// ── Skill files ──────────────────────────────────────────────────────────────

describe("readSteering for a skill file", () => {
  const expected = {
    found: true,
    output: {
      lineage: VOICE,
      label: "Brand voice",
      kind: "skill",
      source: "workspace",
      version: 21,
      path: WORDS_PATH,
      text: workspaceFiles.get(WORDS_PATH),
    },
  };

  it("reads a file named by its bare name in the skill's folder", async () => {
    expect(workspaceFiles.get(WORDS_PATH)).toContain("# Words");
    await expect(
      readSteering(both, { lineage: VOICE, file: "words.md" }, fromFixtures),
    ).resolves.toStrictEqual(expected);
  });

  it("reads a file named with a leading ./", async () => {
    await expect(
      readSteering(both, { lineage: VOICE, file: "./words.md" }, fromFixtures),
    ).resolves.toStrictEqual(expected);
  });

  it("reads a file named by its full path in the repository", async () => {
    await expect(
      readSteering(both, { lineage: VOICE, file: WORDS_PATH }, fromFixtures),
    ).resolves.toStrictEqual(expected);
  });

  it("returns the file's text as written, with no heading", async () => {
    const result = await readSteering(both, { lineage: VOICE, file: "words.md" }, fromFixtures);

    if (!result.found) throw new Error("words.md was not found.");
    expect(result.output.text.startsWith("### ")).toBe(false);
    expect(steeringReadOutputSchema.parse(result.output)).toStrictEqual(result.output);
  });

  it("misses with file_not_found for a file the skill's list does not hold", async () => {
    await expect(
      readSteering(both, { lineage: VOICE, file: "missing.md" }, fromFixtures),
    ).resolves.toStrictEqual({ found: false, miss: "file_not_found" });
  });

  it("misses with file_not_found for the skill's own SKILL.md", async () => {
    await expect(
      readSteering(both, { lineage: VOICE, file: "SKILL.md" }, fromFixtures),
    ).resolves.toStrictEqual({ found: false, miss: "file_not_found" });
  });

  it("misses with file_not_found for a file in another skill's folder", async () => {
    const other = "steering/skills/a-intel.design.house-ui/tokens.json";
    expect(workspaceFiles.has(other)).toBe(true);

    await expect(
      readSteering(both, { lineage: VOICE, file: other }, fromFixtures),
    ).resolves.toStrictEqual({ found: false, miss: "file_not_found" });
  });

  it("misses with file_not_found for a file on a record that is not a skill", async () => {
    await expect(
      readSteering(both, { lineage: REFUND, file: "words.md" }, fromFixtures),
    ).resolves.toStrictEqual({ found: false, miss: "file_not_found" });
  });
});

// ── Body reader ──────────────────────────────────────────────────────────────

describe("recordBodyReader", () => {
  it("returns the body below the frontmatter as the file writes it", async () => {
    const read = recordBodyReader(both, fromFixtures);

    await expect(read("workspace", recordOf(workspace, REFUND))).resolves.toBe(
      `\n${REFUND_STATEMENT}\n`,
    );
  });

  it("throws when the source has no published version", async () => {
    const read = recordBodyReader({ workspace: null, organization }, fromFixtures);

    await expect(read("workspace", recordOf(workspace, REFUND))).rejects.toThrow(
      "The workspace has no published version.",
    );
  });

  it("throws RecordFileError naming the path when the file is not a steering record", async () => {
    const read = recordBodyReader(both, async () => "not a record\n");
    const record = recordOf(workspace, REFUND);

    const error: unknown = await read("workspace", record).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(RecordFileError);
    if (!(error instanceof RecordFileError)) throw new Error("No RecordFileError was thrown.");
    expect(error.name).toBe("RecordFileError");
    expect(error.path).toBe(REFUND_PATH);
    expect(error.message).toBe(
      `${REFUND_PATH} is not a steering record file, so its body cannot be read.`,
    );
  });
});
