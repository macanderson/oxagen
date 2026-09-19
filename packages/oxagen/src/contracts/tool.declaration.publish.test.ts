import { describe, expect, it } from "vitest";
import {
  TOOL_NAME_MAX_LENGTH,
  toolDeclarationPublish,
} from "./tool.declaration.publish";
import { getCapability } from "../registry";

const VALID_INPUT = {
  name: "read_file",
  description: "Read a file from the workspace",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
  risk_grade: "low",
  source: "builtin",
  manifest: { name: "read_file", version: "1.0.0" },
};

describe("tool.declaration.publish capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("publish_tool_declaration")).toBe(
      toolDeclarationPublish,
    );
  });

  it("is an api-only, high-sensitivity, default-deny governance write", () => {
    expect(toolDeclarationPublish.surfaces).toEqual(["api"]);
    expect(toolDeclarationPublish.sensitivity).toBe("high");
    expect(toolDeclarationPublish.defaultEffect).toBe("deny");
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts a valid declaration and defaults read_only to false", () => {
    const parsed = toolDeclarationPublish.input.parse(VALID_INPUT);
    expect(parsed.name).toBe("read_file");
    expect(parsed.read_only).toBe(false);
  });

  it("rejects a name longer than a run spec's tool identity can carry", () => {
    // Not a cosmetic bound. The tool is governed under
    // `mcp.<server uuid>.<name>`, which openAssistantRun pins into the run
    // spec's tool policy — and the spec pins every materialized tool, so a
    // name the registry accepts and the spec refuses fails admission for
    // every assistant turn in the workspace, not just this tool's calls.
    expect(() =>
      toolDeclarationPublish.input.parse({
        ...VALID_INPUT,
        name: "a".repeat(TOOL_NAME_MAX_LENGTH + 1),
      }),
    ).toThrow();
    // The boundary itself is accepted: a bound that also refuses the longest
    // legal name is the same outage with a better message.
    expect(() =>
      toolDeclarationPublish.input.parse({
        ...VALID_INPUT,
        name: "a".repeat(TOOL_NAME_MAX_LENGTH),
      }),
    ).not.toThrow();
  });

  it("rejects a missing name", () => {
    const { name: _name, ...rest } = VALID_INPUT;
    expect(() => toolDeclarationPublish.input.parse(rest)).toThrow();
  });

  it("rejects an unknown risk grade", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({
        ...VALID_INPUT,
        risk_grade: "extreme",
      }),
    ).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({ ...VALID_INPUT, source: "plugin" }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({ ...VALID_INPUT, extra: true }),
    ).toThrow();
  });

  // #3448 (residue from #3442, ADR-111): a non-ISO-4217 unit on an `amount`
  // measure is refused here, at the one boundary every tool declaration
  // passes through, rather than reaching the mandate page and failing
  // `Money.safeParse` for every mandate naming the measure at once.
  it("rejects an amount measure whose unit is not an ISO 4217 currency code", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({
        ...VALID_INPUT,
        measures: {
          amount: { path: "amount", type: "amount", unit: "USDC", scale: 2 },
        },
      }),
    ).toThrow(/ISO 4217/);
  });

  it("accepts an amount measure denominated in a real ISO 4217 code", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({
        ...VALID_INPUT,
        measures: {
          amount: { path: "amount", type: "amount", unit: "USD", scale: 2 },
        },
      }),
    ).not.toThrow();
  });

  it("accepts a count measure denominated in a non-ISO unit (e.g. a token)", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({
        ...VALID_INPUT,
        measures: {
          balance: { path: "balance", type: "count", unit: "USDC" },
        },
      }),
    ).not.toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = toolDeclarationPublish.output.parse({
      publicId: "tol_abc",
      slug: "read_file",
      version: 2,
      checksum: "a".repeat(64),
      published: true,
    });
    expect(parsed.version).toBe(2);
  });

  it("rejects a non-positive version", () => {
    expect(() =>
      toolDeclarationPublish.output.parse({
        publicId: "tol_abc",
        slug: "read_file",
        version: 0,
        checksum: "a".repeat(64),
        published: true,
      }),
    ).toThrow();
  });
});
