// The Tools ports on the kernel (ARCHITECTURE.md §3.3; #2958): the workspace
// registry's tool versions, the credential broker's grants, the kill switches
// reaching this workspace, and the workspace's auto-approval rules. All four
// are `noBillingGate` reads whose role gate lives in the handler (INV-29), so
// a member without it comes back as `denied` and the tab shows the
// access-denied state rather than an empty table. An answer a view model
// refuses is reported once as record_unmappable.
import "server-only";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ApprovalRuleSet,
  CredentialGrantPage,
  KILL_SWITCH_BOARD_LIMIT,
  KillSwitchBoard,
  ToolVersionPage,
} from "@/data/contracts/tools";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toApprovalRuleSet,
  toCredentialGrantPage,
  toKillSwitchBoard,
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
};
