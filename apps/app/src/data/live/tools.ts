// The Tools ports on the kernel (ARCHITECTURE.md §3.3; #2958): the workspace
// registry's tool versions, the credential broker's grants, and the kill
// switches reaching this workspace. All three are `noBillingGate` reads whose
// role gate lives in the handler (INV-29), so a member without it comes back
// as `denied` and the tab shows the access-denied state rather than an empty
// table. An answer a view model refuses is reported once as record_unmappable.
import "server-only";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  CredentialGrantPage,
  KillSwitchBoard,
  ToolVersionPage,
} from "@/data/contracts/tools";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
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
    const read = await kernelRead(ctx, {
      contract: killSwitchList,
      input: {},
      page: "tools",
    });
    if (!read.ok) return read;
    return mapped(
      KillSwitchBoard,
      toKillSwitchBoard(read.value),
      "tools.killSwitches",
      ctx.orgId,
    );
  },
};
