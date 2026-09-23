// audit-exempt: read-only. The kernel records access to verified steering manifests.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextSteeringDeliveries } from "@oxagen/oxagen/contracts/context.steering.deliveries";
import { selectSteeringDeliveries } from "@oxagen/telemetry";

export const getSteeringDeliveriesHandler: CapabilityHandler<
  typeof contextSteeringDeliveries
> = async (input) => {
  const toMs = Date.now();
  return selectSteeringDeliveries({
    fromMs: toMs - input.days * 86_400_000,
    toMs,
    limit: input.limit,
  });
};
