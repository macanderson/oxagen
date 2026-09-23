// The shell's approvals drawer opens on a window event, so a client island on
// any page can open it without importing the shell barrel and its server code.
const APPROVALS_EVENT = "oxagen:open-approvals";

export function openApprovals(): void {
  window.dispatchEvent(new Event(APPROVALS_EVENT));
}

export function subscribeApprovals(open: () => void): () => void {
  window.addEventListener(APPROVALS_EVENT, open);
  return () => {
    window.removeEventListener(APPROVALS_EVENT, open);
  };
}
