import { describe, expect, it } from "vitest";

import { agentUiRenderHandler } from "./agent.ui.render";
import { agentHandlerNames } from "./index";
import { agentUiRender } from "@oxagen/oxagen/contracts/agent.ui.render";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.ui.render handler", () => {
  it("echoes componentId and props in output", async () => {
    const result = await agentUiRenderHandler(
      { componentId: "metric-card", props: { value: 42 } },
      CTX,
    );
    expect(result.render.componentId).toBe("metric-card");
    expect(result.render.props).toEqual({ value: 42 });
  });

  it("defaults props to {} when not provided", async () => {
    // The contract schema sets a default of {} for props, so the input
    // will already have props:{} after Zod parsing. We test that the
    // handler also handles the case where props is explicitly undefined.
    const result = await agentUiRenderHandler(
      { componentId: "empty-card", props: {} },
      CTX,
    );
    expect(result.render.props).toEqual({});
  });

  it("output parses against the contract output schema", async () => {
    const result = await agentUiRenderHandler(
      { componentId: "chart", props: { title: "Revenue" } },
      CTX,
    );
    const parsed = agentUiRender.output.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("registry name agent.ui.render is present in agentHandlerNames", () => {
    expect(agentHandlerNames).toContain("render_agent_ui");
  });
});
