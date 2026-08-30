import { describe, it, expect } from "vitest";
import { agentUiRender } from "./agent.ui.render";
import { getCapability } from "../registry";

describe("agent.ui.render capability", () => {
  it("is registered", () => {
    expect(getCapability("render_agent_ui")).toBeDefined();
  });

  it("parses a valid input with componentId only", () => {
    expect(() =>
      agentUiRender.input.parse({ componentId: "workflow-progress" }),
    ).not.toThrow();
  });

  it("parses a valid input with componentId and props", () => {
    expect(() =>
      agentUiRender.input.parse({
        componentId: "image-preview",
        props: { src: "https://example.com/img.png", alt: "Generated image" },
      }),
    ).not.toThrow();
  });

  it("applies default empty props when omitted", () => {
    const result = agentUiRender.input.parse({ componentId: "my-component" });
    expect(result.props).toEqual({});
  });

  it("rejects input with empty componentId", () => {
    expect(() => agentUiRender.input.parse({ componentId: "" })).toThrow();
  });

  it("rejects input missing componentId", () => {
    expect(() => agentUiRender.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    expect(() =>
      agentUiRender.output.parse({
        render: {
          componentId: "workflow-progress",
          props: { workflowId: "wfr_abc123" },
        },
      }),
    ).not.toThrow();
  });

  it("parses a valid output with empty props", () => {
    expect(() =>
      agentUiRender.output.parse({
        render: { componentId: "my-component", props: {} },
      }),
    ).not.toThrow();
  });

  it("rejects output missing render field", () => {
    expect(() => agentUiRender.output.parse({})).toThrow();
  });

  it("rejects output with render missing componentId", () => {
    expect(() =>
      agentUiRender.output.parse({
        render: { props: {} },
      }),
    ).toThrow();
  });

  it("has correct defaultEffect and defaultRoles", () => {
    expect(agentUiRender.defaultEffect).toBe("deny");
    expect(agentUiRender.defaultRoles?.org?.Owner).toBe("allow");
    expect(agentUiRender.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
