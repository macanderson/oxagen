import type { DataSource } from "@/data/ports";
import { readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";

export const runs: DataSource["runs"] = {
  async list() {
    return readOk({ runs: [], cursor: null });
  },
  get: (ctx, runId) =>
    kernelRead(ctx, { contract: runGet, input: { runId }, page: "run" }),
};
