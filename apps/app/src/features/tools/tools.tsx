// Tools (#2957): the mandates ledger, the one section of this page with a
// store behind it. Its other sections — the registry, connections, kill
// switches and auto-approval rules — arrive with the #2958 lane and render
// nothing until then (§3.6).
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { MandatesLedger } from "./mandates-ledger";

export async function Tools({
  ctx,
  source,
}: {
  ctx: WsCtx;
  source: DataSource;
}) {
  return (
    <div className="flex flex-col gap-6">
      <MandatesLedger
        read={await source.mandates.list(ctx, { agentId: null })}
        orgRole={ctx.orgRole}
      />
    </div>
  );
}
