// The live shell adapter. Notifications are live: the audit adapter reads
// list_notifications (./audit.ts `liveNotifications`), and ./index.ts serves it
// in place of the stub below. Every other method waits on its store's lane and
// returns the milestone and gap it waits on (src/data/backing.ts), never a
// fabricated value, and the shell renders that honestly: a slug for the
// organization name, no counts, and the assistant engine named as unreachable.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { ShellReadPort } from "@/data/ports";

export const liveShell: ShellReadPort = {
  context: () => Promise.resolve(notBackedFor("shell", "context")),
  navCounts: () => Promise.resolve(notBackedFor("shell", "navCounts")),
  // Superseded in ./index.ts by liveNotifications (./audit.ts).
  notifications: () => Promise.resolve(notBackedFor("shell", "notifications")),
  people: () => Promise.resolve(notBackedFor("shell", "people")),
  assistantEngine: () =>
    Promise.resolve(notBackedFor("shell", "assistantEngine")),
  recentRuns: () => Promise.resolve(notBackedFor("shell", "recentRuns")),
  account: () => Promise.resolve(notBackedFor("shell", "account")),
};
