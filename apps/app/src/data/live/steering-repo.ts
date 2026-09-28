// The steering repo port on the kernel (ARCHITECTURE.md §3.3; lane S2,
// #4560): `get_steering_repo`, a noBillingGate kernelRead on the workspace
// ctx. The contract answers in the view's own shape and the kernel parses the
// answer against the contract's output schema, so no mapper sits between them
// (data/contracts/steering-repo.ts says why). The read is made for the
// Repositories page's card, so a denial names that page's `repository.read`,
// the permission of the contract's domain.
import "server-only";
import { steeringRepoGet } from "@oxagen/oxagen/contracts/steering_repo.get";
import type { DataSource } from "@/data/ports";
import { kernelRead } from "@/server/kernel";

export const steeringRepo: DataSource["steeringRepo"] = {
  async get(ctx) {
    return await kernelRead(ctx, {
      contract: steeringRepoGet,
      input: {},
      page: "repositories",
    });
  },
};
