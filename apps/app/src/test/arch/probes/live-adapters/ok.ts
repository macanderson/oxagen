import type { DataSource } from "@/data/ports";
import { kernelRead } from "@/server/kernel";

function page(): "shell" {
  return "shell";
}

export const shell: DataSource["shell"] = {
  async context(ctx) {
    return kernelRead(ctx, { contract: orgList, input: {}, page: page() });
  },
};
