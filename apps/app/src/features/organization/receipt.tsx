"use client";
// The receipt a governed write leaves on the Organization pages (the mockup's
// `act()`): one line in the toast stack saying what changed and that it is in
// the audit record. The kernel writes an audit row on every capability call
// (packages/oxagen/src/kernel.ts, the injected audit emitter), so the line
// claims only what the record holds.
//
// Most writes here re-read the page afterwards, and a re-read can remount the
// tab the write was made from. The receipts are therefore kept in this
// module, not in a component's state: a write records its line, the frame's
// `<Receipts />` shows whatever is pending, and a remounted stack picks the
// line up where the old one left it. Each line leaves after the toast's own
// 4.2 seconds.
import { useSyncExternalStore } from "react";
import { TOAST_MS, ToastStack } from "@/ui/toast";

type Receipt = { id: number; text: string; tone: "allowed" };

const NONE: readonly Receipt[] = [];
let receipts: readonly Receipt[] = NONE;
let nextId = 0;
const listeners = new Set<() => void>();

function publish(next: readonly Receipt[]) {
  receipts = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shows one receipt line; call it once the write answered ok. */
export function recordReceipt(text: string): void {
  nextId += 1;
  const id = nextId;
  publish([...receipts, { id, text, tone: "allowed" }]);
  setTimeout(() => {
    publish(receipts.filter((row) => row.id !== id));
  }, TOAST_MS);
}

/** The receipts still on screen, as a polite live region. */
export function Receipts() {
  const rows = useSyncExternalStore(
    subscribe,
    () => receipts,
    () => NONE,
  );
  return <ToastStack toasts={rows} testId="organization-receipts" />;
}
