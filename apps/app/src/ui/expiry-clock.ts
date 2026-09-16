"use client";
// The clock a row judges its own expiry against.
//
// A page reads its rows once and the instant it read them travels with them, so
// every state derived from that instant is frozen at the render. A credential
// or an enrollment left on screen across its `expiresAt` then keeps saying
// "active" while authentication already refuses it — a claim about authority
// the record does not support.
//
// So a row that still has an expiry ahead of it re-reads the clock until it
// crosses. A row with no expiry, or one already past, sets no timer: there is
// nothing left for it to learn, and a timer per row on a long table is a cost
// paid for nothing.
//
// This is always the courtesy, never the guarantee. The handler judges against
// its own clock and refuses — `packages/auth/src/resolvers/api-key.ts` for a
// key, `packages/handlers/src/lib/tacho-host.ts` for an enrollment — on the API
// and MCP as well as here.
import { useEffect, useState } from "react";

/** How long a row waits before it re-reads the clock. */
const EXPIRY_TICK_MS = 30_000;

/**
 * The server's instant, then the browser's once this row has an expiry to
 * cross. Pass the result to `credentialState` so the word, and any control
 * beside it, are judged against one instant and cannot disagree.
 */
export function useExpiryClock(expiresAt: string | null, now: number): number {
  const [current, setCurrent] = useState(now);
  const pending = expiresAt !== null && Date.parse(expiresAt) > current;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      setCurrent(Date.now());
    }, EXPIRY_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [pending]);
  return current;
}
