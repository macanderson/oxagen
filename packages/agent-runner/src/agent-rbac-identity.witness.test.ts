import { describe, expect, it } from "vitest";
import { mapClaimedRunRow } from "./run-store";

describe("durable agent run identity", () => {
  it("carries the persistent agent principal and invoking human principal when claimed", () => {
    const claimed = mapClaimedRunRow({
      id: "run-1",
      public_id: "arun-1",
      org_id: "org-1",
      workspace_id: "ws-1",
      surface: "api-chat",
      spec: { version: 1, instruction: "help" },
      attempts: 1,
      checkpoint: null,
      checkpoint_seq: 0,
      agent_principal_id: "principal-agent",
      agent_principal_kind: "agent",
      agent_principal_org_id: "org-1",
      agent_principal_workspace_id: "ws-1",
      human_principal_id: "principal-human",
      human_principal_kind: "human",
      human_principal_org_id: "org-1",
      human_principal_workspace_id: "ws-1",
    } as Parameters<typeof mapClaimedRunRow>[0]);

    expect(claimed).toMatchObject({
      agentPrincipal: {
        id: "principal-agent",
        kind: "agent",
        orgId: "org-1",
        workspaceId: "ws-1",
      },
      humanPrincipal: {
        id: "principal-human",
        kind: "human",
        orgId: "org-1",
        workspaceId: "ws-1",
      },
    });
  });
});
