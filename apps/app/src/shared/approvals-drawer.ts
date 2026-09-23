"use client";

// A page may open the shell's approvals drawer. The shell listens for this
// event, so a page never imports the shell, whose barrel carries server-only
// modules into the client bundle.
const APPROVALS_EVENT = "oxagen:open-approvals";

export function openApprovals(): void {
  window.dispatchEvent(new Event(APPROVALS_EVENT));
}

export function subscribeApprovals(open: () => void): () => void {
  window.addEventListener(APPROVALS_EVENT, open);
  return () => window.removeEventListener(APPROVALS_EVENT, open);
}
