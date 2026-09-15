// The organization port on the kernel (ARCHITECTURE.md §3.3): the members and
// pending invitations of the viewer's organization, list_members {scope:"org"},
// a noBillingGate read.
import "server-only";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { captureError } from "@oxagen/telemetry";
import { MemberList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toMemberList } from "./mappers/org";

export const org: DataSource["org"] = {
  async members(ctx) {
    const read = await kernelRead(ctx, {
      contract: listMembers,
      input: { scope: "org" },
      page: "organization",
    });
    if (!read.ok) return read;
    const view =
      read.value.scope === "org"
        ? MemberList.safeParse(toMemberList(read.value))
        : null;
    if (view?.success) return readOk(view.data);
    captureError({
      error: view?.error ?? new Error("list_members answered workspace scope"),
      source: "app",
      orgId: ctx.orgId,
      context: "org.members record_unmappable",
    });
    return readError("record_unmappable", 502);
  },
};
