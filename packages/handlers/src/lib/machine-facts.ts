import type { TachoEvent } from "@oxagen/tacho";

/** Keep one frame's host observation together. Enrollment is a separate source. */
export function machineSnapshotOf(events: readonly TachoEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const host = event?.host;
    const platform = host?.os_type?.trim() || null;
    const osVersion = host?.os_version?.trim() || null;
    const arch = host?.host_arch?.trim() || null;
    if (
      event === undefined ||
      (platform === null && osVersion === null && arch === null)
    )
      continue;
    return {
      platform,
      osVersion,
      arch,
      recordedAt: event.ts,
      eventHash: event.hash,
    };
  }
  return undefined;
}
