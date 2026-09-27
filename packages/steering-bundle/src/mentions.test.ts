import { describe, expect, it } from "vitest";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import {
  renderMentions,
  toolMentionText,
  toolModesOf,
  type ExposureMode,
  type ToolModes,
} from "./mentions";

const NONE: ToolModes = new Map<string, ExposureMode>();
const BILLING_SEARCH: ToolModes = new Map<string, ExposureMode>([["billing", "search"]]);
const BILLING_DIRECT: ToolModes = new Map<string, ExposureMode>([["billing", "direct"]]);
const MIXED: ToolModes = new Map<string, ExposureMode>([
  ["billing", "search"],
  ["stripe", "direct"],
]);

describe("toolMentionText", () => {
  it("returns a name it cannot split into server and tool unchanged, whatever the modes", () => {
    expect(toolMentionText("billing", BILLING_SEARCH)).toBe("billing");
  });

  it("returns the tool's name when its server is in direct mode", () => {
    expect(toolMentionText("billing__cancel_refund", BILLING_DIRECT)).toBe(
      "billing__cancel_refund",
    );
  });

  it("returns the tool's name when its server has no mode, which reads as direct", () => {
    expect(toolMentionText("billing__cancel_refund", NONE)).toBe("billing__cancel_refund");
    expect(toolMentionText("stripe__list_charges", BILLING_SEARCH)).toBe("stripe__list_charges");
  });

  it("names the server's call tool when its server is in search mode", () => {
    expect(toolMentionText("billing__cancel_refund", BILLING_SEARCH)).toBe(
      "call billing__call with tool cancel_refund",
    );
  });
});

describe("renderMentions", () => {
  it("leaves a body with no tool mention unchanged", () => {
    const body = "A refund belongs to one charge (`billing__get_charge`) and one customer.";
    expect(renderMentions(body, BILLING_SEARCH)).toBe(body);
  });

  it("leaves record and skill mentions as written", () => {
    const body = "Read @record:a-intel.domain.refund, then follow @skill:a-intel.brand.voice.";
    expect(renderMentions(body, BILLING_SEARCH)).toBe(body);
  });

  it("replaces two tool mentions in one body", () => {
    const body = "Cancel with @tool:billing__cancel_refund, then check @tool:billing__get_charge.";
    expect(renderMentions(body, BILLING_SEARCH)).toBe(
      "Cancel with call billing__call with tool cancel_refund, then check call billing__call with tool get_charge.",
    );
  });

  it("writes a mention as the bare tool name when its server has no mode", () => {
    const body = "Only `pending` can be canceled, with `@tool:billing__cancel_refund`.";
    expect(renderMentions(body, NONE)).toBe(
      "Only `pending` can be canceled, with `billing__cancel_refund`.",
    );
  });

  it("renders each mention for its own server's mode", () => {
    const body = "Use @tool:billing__cancel_refund and @tool:stripe__list_charges.";
    expect(renderMentions(body, MIXED)).toBe(
      "Use call billing__call with tool cancel_refund and stripe__list_charges.",
    );
  });
});

describe("toolModesOf", () => {
  it("returns an empty map when the tool manifest is null", () => {
    expect(toolModesOf({ tools: null }).size).toBe(0);
  });

  it("returns an empty map when the manifest has no server list", () => {
    expect(toolModesOf({ tools: { schema: "tool-manifest/v1" } }).size).toBe(0);
    expect(toolModesOf({ tools: { schema: "tool-manifest/v1", servers: "billing" } }).size).toBe(0);
  });

  it("reads each server's exposure mode by server name", () => {
    const tools: Bundle["tools"] = {
      schema: "tool-manifest/v1",
      servers: [
        { name: "billing", exposure: { mode: "search" } },
        { name: "stripe", exposure: { mode: "direct" } },
      ],
    };
    expect([...toolModesOf({ tools })]).toStrictEqual([
      ["billing", "search"],
      ["stripe", "direct"],
    ]);
  });

  it("skips a server with no name, no exposure, or a mode it does not know", () => {
    const tools: Bundle["tools"] = {
      schema: "tool-manifest/v1",
      servers: [
        null,
        "text",
        { name: 7, exposure: { mode: "search" } },
        { name: "legacy" },
        { name: "odd", exposure: { mode: "hidden" } },
        { name: "billing", exposure: { mode: "search" } },
      ],
    };
    expect([...toolModesOf({ tools })]).toStrictEqual([["billing", "search"]]);
  });
});
