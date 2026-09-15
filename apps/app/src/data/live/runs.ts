// The runs port on the kernel (ARCHITECTURE.md §3.3): one cursor page of
// list_runs, a noBillingGate read, mapped into the Fleet runs page.
import "server-only";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { captureError } from "@oxagen/telemetry";
import { RunPage } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toRunPage } from "./mappers/runs";

export const runs: DataSource["runs"] = {
  async list(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: runList,
      input: q.cursor === null ? {} : { cursor: q.cursor },
      page: "fleet",
    });
    if (!read.ok) return read;
    const view = RunPage.safeParse(toRunPage(read.value));
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "runs.list record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },
};
