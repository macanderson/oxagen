import { describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import type { Delivery } from "@oxagen/steering-bundle";
import { createSteeringReadHandler, steeringReadMiss } from "./steering.read";
import type { SteeringScope } from "./steering.search";
import {
  fixtureDelivery,
  readFixtureFile,
  SCOPE,
  steeringCtx,
} from "./steering.test-support";

const delivery = await fixtureDelivery();

function handler(published: Delivery = delivery) {
  return createSteeringReadHandler({
    published: () => Promise.resolve(published),
    readFile: readFixtureFile,
  });
}

async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HandlerError);
    return error as HandlerError;
  }
  throw new Error("expected a HandlerError");
}

describe("steering_read", () => {
  it("reads a record as the model reads it, with no frontmatter", async () => {
    const published = vi.fn(() => Promise.resolve(delivery));
    const read = createSteeringReadHandler({ published, readFile: readFixtureFile });
    const output = await read({ lineage: "a-intel.domain.refund" }, steeringCtx());
    expect(published).toHaveBeenCalledWith(SCOPE);
    expect(output).toMatchObject({
      lineage: "a-intel.domain.refund",
      label: "Refund",
      kind: "fact",
      source: "workspace",
      version: 21,
      path: "steering/domain/a-intel.domain.refund.md",
    });
    expect(output.text.startsWith("### Refund\n")).toBe(true);
    expect(output.text).not.toContain("schema: steering-record/v1");
    expect(output.text.endsWith("\n")).toBe(true);
  });

  it("reads an organization record from the organization's version", async () => {
    const output = await handler()({ lineage: "a-intel.security.no-secrets-in-code" }, steeringCtx());
    expect(output.source).toBe("organization");
    expect(output.version).toBe(4);
    expect(output.text).toBe(
      "### No secrets in code\n" +
        "Do not write a key, a token, or a password into a file or a commit. Read it\n" +
        "from the environment the run provides, and ask a person when it is missing.\n",
    );
  });

  it("reads one file from a skill's folder", async () => {
    const output = await handler()(
      { lineage: "a-intel.brand.voice", file: "words.md" },
      steeringCtx(),
    );
    expect(output.path).toBe("steering/skills/a-intel.brand.voice/words.md");
    expect(output.text).toBe(fixtureRepo().get(output.path));
  });

  it("refuses a lineage no published version holds", async () => {
    const error = await refusal(handler()({ lineage: "a-intel.brand.missing" }, steeringCtx()));
    expect(error.code).toBe("not_found");
    expect(error.reason).toBe("steering_record_not_found");
    expect(error.message).toBe(
      "No published steering version holds a-intel.brand.missing. Find the lineage with steering_search.",
    );
  });

  it("refuses every lineage before anything publishes", async () => {
    const error = await refusal(
      handler({ workspace: null, organization: null })({ lineage: "a-intel.domain.refund" }, steeringCtx()),
    );
    expect(error.reason).toBe("steering_record_not_found");
  });

  it("refuses a file the skill's folder does not hold", async () => {
    const error = await refusal(
      handler()({ lineage: "a-intel.brand.voice", file: "missing.md" }, steeringCtx()),
    );
    expect(error.code).toBe("not_found");
    expect(error.reason).toBe("steering_file_not_found");
    expect(error.message).toBe(
      "a-intel.brand.voice has no file named missing.md. Name a file in the skill's folder, such as words.md.",
    );
  });

  it("reads the version a run was delivered after a newer version drops the record", async () => {
    const workspace = delivery.workspace;
    if (workspace === null) throw new Error("The fixture delivery has no workspace version.");
    const newer: Delivery = {
      ...delivery,
      workspace: {
        ...workspace,
        version: 22,
        records: workspace.records.filter((record) => record.lineage !== "a-intel.domain.refund"),
      },
    };
    const published = vi.fn((scope: SteeringScope) =>
      Promise.resolve(scope.runId === "run_1" ? delivery : newer),
    );
    const read = createSteeringReadHandler({ published, readFile: readFixtureFile });

    const output = await read({ lineage: "a-intel.domain.refund" }, steeringCtx("run_1"));
    expect(published).toHaveBeenCalledWith({ ...SCOPE, runId: "run_1" });
    expect(output.version).toBe(21);

    const error = await refusal(read({ lineage: "a-intel.domain.refund" }, steeringCtx()));
    expect(error.reason).toBe("steering_record_not_found");
  });

  it("refuses input the tool does not take, before it reads a version", async () => {
    const published = vi.fn(() => Promise.resolve(delivery));
    const read = createSteeringReadHandler({ published, readFile: readFixtureFile });
    await expect(read({ lineage: "Not A Lineage" }, steeringCtx())).rejects.toThrow();
    await expect(read({ lineage: "a-intel.domain.refund", version: 3 }, steeringCtx())).rejects.toThrow();
    expect(published).not.toHaveBeenCalled();
  });
});

describe("steeringReadMiss", () => {
  it("names the file a read asked for, or none", () => {
    expect(steeringReadMiss("file_not_found", "a-intel.brand.voice", undefined).message).toBe(
      "a-intel.brand.voice has no file named (none). Name a file in the skill's folder, such as words.md.",
    );
  });
});
