// The Tools ports on the kernel (ARCHITECTURE.md §3.3; #2958): the workspace
// registry's tool versions, the credential broker's grants, the kill switches
// reaching this workspace, the workspace's auto-approval rules, its data-source
// connections and the MCP servers the registry imports from. The role gate on
// each of them lives in the handler or in IAM (INV-29), so a member without it
// comes back as `denied` and the tab shows the access-denied state rather than
// an empty table. An answer a view model refuses is reported once as
// record_unmappable.
//
// The first four declare `noBillingGate`; `list_connections` and
// `list_mcp_servers` do not, so an org out of credits is refused those two as
// `exhausted`, which the seam answers with the page's error state rather than
// a credit message it has no read variant for (data/read.ts).
import "server-only";
import { agentMcpList } from "@oxagen/oxagen/contracts/agent.mcp.list";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ApprovalRuleSet,
  ConnectionList,
  CredentialGrantPage,
  KILL_SWITCH_BOARD_LIMIT,
  KillSwitchBoard,
  McpServerList,
  ToolVersionPage,
} from "@/data/contracts/tools";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toApprovalRuleSet,
  toConnectionList,
  toCredentialGrantPage,
  toKillSwitchBoard,
  toMcpServerList,
  toToolVersionPage,
} from "./mappers/tools";

/** The one place a mapped record is checked against its view model. */
function mapped<T, I>(
  shape: z.ZodType<T, I>,
  value: I,
  where: string,
  orgId: string,
): Read<T> {
  const parsed = shape.safeParse(value);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${where} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const tools: DataSource["tools"] = {
  async versions(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: toolVersionList,
      input: {
        ...(q.category === null ? {} : { category: q.category }),
        ...(q.cursor === null ? {} : { cursor: q.cursor }),
        ...(q.serverId === null ? {} : { serverId: q.serverId }),
      },
      page: "tools",
    });
    if (!read.ok) return read;
    return mapped(
      ToolVersionPage,
      toToolVersionPage(read.value),
      "tools.versions",
      ctx.orgId,
    );
  },

  async grants(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: credentialGrantList,
      input: q.cursor === null ? {} : { cursor: q.cursor },
      page: "tools",
    });
    if (!read.ok) return read;
    return mapped(
      CredentialGrantPage,
      toCredentialGrantPage(read.value),
      "tools.grants",
      ctx.orgId,
    );
  },

  async killSwitches(ctx) {
    // `list_kill_switches` has no cursor, so the board asks for the ceiling the
    // contract offers and the view model carries whether it hit it (#3131):
    // a switch that is denying and off the end of this read is one the page
    // would otherwise neither count nor let anyone clear.
    const read = await kernelRead(ctx, {
      contract: killSwitchList,
      input: { limit: KILL_SWITCH_BOARD_LIMIT },
      page: "tools",
    });
    if (!read.ok) return read;
    return mapped(
      KillSwitchBoard,
      toKillSwitchBoard(read.value, KILL_SWITCH_BOARD_LIMIT),
      "tools.killSwitches",
      ctx.orgId,
    );
  },

  async approvalRules(ctx) {
    // The contract returns the whole set (at most 256 rules), so there is no
    // cursor and nothing to truncate.
    const read = await kernelRead(ctx, {
      contract: approvalRuleList,
      input: {},
      page: "tools",
    });
    if (!read.ok) return read;
    return mapped(
      ApprovalRuleSet,
      toApprovalRuleSet(read.value),
      "tools.approvalRules",
      ctx.orgId,
    );
  },

  async connections(ctx, q) {
    // `list_connections` carries no cursor: the filter it takes is the whole
    // narrowing it offers, and the answer is every connection that matches.
    const read = await kernelRead(ctx, {
      contract: connectionList,
      input: {
        ...(q.status === null ? {} : { status: q.status }),
        ...(q.connectorId === null ? {} : { connectorId: q.connectorId }),
      },
      page: "tools",
    });
    if (!read.ok) return read;
    return mapped(
      ConnectionList,
      toConnectionList(read.value),
      "tools.connections",
      ctx.orgId,
    );
  },

  async mcpServers(ctx) {
    // The contract's input is the empty object: the whole roster, with no
    // filter and no cursor to page.
    const read = await kernelRead(ctx, {
      contract: agentMcpList,
      input: {},
      page: "tools",
    });
    if (!read.ok) return read;
    return mapped(
      McpServerList,
      toMcpServerList(read.value),
      "tools.mcpServers",
      ctx.orgId,
    );
  },
};
