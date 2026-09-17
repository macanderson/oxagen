import { kernelRead } from "@/server/kernel";

export const org = {
  members: (ctx: never) => kernelRead(ctx, never),
};

export function apiKeys(ctx: never) {
  return kernelRead(ctx, never);
}
