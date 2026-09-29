"use client";
// The receipt a governed write leaves on the Organization pages (the mockup's
// `act()`): one line in the app's toast stack saying what changed and that it
// is in the audit record. The kernel writes an audit row on every capability
// call (packages/oxagen/src/kernel.ts, the injected audit emitter), so the
// line claims only what the record holds.
//
// Most writes here re-read the page afterwards, and a re-read can remount the
// tab the write was made from. The line goes to the toaster the root layout
// mounts once (@/ui/toast), so a remounted tab or a closed dialog does not
// take it along. It leaves after the toast's own 4.2 seconds.
import { toast } from "@/ui/toast";

/** Shows one receipt line; call it once the write answered ok. */
export function recordReceipt(text: string): void {
  toast(text, "allowed");
}
