import { describe, it, expect } from "vitest";
import { agentUiRenderHandler } from "./agent.ui.render";
import type { CapabilityContext } from "@oxagen/oxagen";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "app",
  messageId: null,
};

describe("agentUiRenderHandler", () => {
  it("returns render directive with the given componentId", async () => {
    const result = await agentUiRenderHandler(
      { componentId: "create-workspace-inline", props: {} },
      CTX,
    );
    expect(result.render.componentId).toBe("create-workspace-inline");
  });

  it("forwards props unchanged into the render directive", async () => {
    const props = { orgSlug: "acme", workspaceSlug: "main", title: "New workspace" };
    const result = await agentUiRenderHandler(
      { componentId: "invite-member-inline", props },
      CTX,
    );
    expect(result.render.props).toEqual(props);
  });

  it("returns empty props object when props omitted (defaults to {})", async () => {
    const result = await agentUiRenderHandler(
      { componentId: "billing-upgrade-inline", props: {} },
      CTX,
    );
    expect(result.render.props).toEqual({});
  });

  it("works with every expected componentId without throwing", async () => {
    const ids = [
      "create-workspace-inline",
      "create-org-inline",
      "invite-member-inline",
      "model-settings-inline",
      "billing-upgrade-inline",
      "credits-purchase-inline",
      "confirm-destructive-inline",
    ];
    for (const componentId of ids) {
      await expect(
        agentUiRenderHandler({ componentId, props: {} }, CTX),
      ).resolves.not.toThrow();
    }
  });

  it("passes arbitrary unknown props through without coercion", async () => {
    const props = { foo: 42, bar: true, nested: { x: 1 } };
    const result = await agentUiRenderHandler(
      { componentId: "confirm-destructive-inline", props },
      CTX,
    );
    expect(result.render.props.foo).toBe(42);
    expect(result.render.props.bar).toBe(true);
    expect(result.render.props.nested).toEqual({ x: 1 });
  });

  it("render.componentId matches input.componentId for any value", async () => {
    const id = "custom-component-xyz";
    const result = await agentUiRenderHandler({ componentId: id, props: {} }, CTX);
    expect(result.render.componentId).toBe(id);
  });

  it("never throws for minimal input", async () => {
    await expect(
      agentUiRenderHandler({ componentId: "x", props: {} }, CTX),
    ).resolves.not.toThrow();
  });
});
