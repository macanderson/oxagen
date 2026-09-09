import { beforeEach, describe, expect, it, vi } from "vitest";

const { listConsentsMock } = vi.hoisted(() => ({ listConsentsMock: vi.fn() }));

vi.mock("../runtime/consent", () => ({ listConsents: listConsentsMock }));

import { agentMcpConsentListHandler } from "./agent.mcp_consent.list";
import { TEST_CTX } from "../test-utils/fixtures";

beforeEach(() => {
  listConsentsMock.mockReset();
});

describe("agent.mcp_consent.list handler", () => {
  it("scopes the query to the caller when mineOnly is set", async () => {
    const consents = [{ serverId: "srv_1", toolName: "search" }];
    listConsentsMock.mockResolvedValueOnce(consents);

    const out = await agentMcpConsentListHandler({ mineOnly: true }, TEST_CTX);

    expect(listConsentsMock).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "u_1",
    });
    expect(out.consents).toBe(consents);
  });

  it("lists the whole workspace when mineOnly is not set", async () => {
    listConsentsMock.mockResolvedValueOnce([]);

    await agentMcpConsentListHandler({ mineOnly: false }, TEST_CTX);

    expect(listConsentsMock).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: null,
    });
  });
});
