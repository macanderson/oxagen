// The live shell adapter. Batch 3 lane A10 (audit + shell) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value, and the
// shell renders that honestly: a slug for the organization name, no counts, and
// the assistant engine named as unreachable.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { ShellReadPort } from "@/data/ports";

export const liveShell: ShellReadPort = {
  context: () => Promise.resolve(notBackedFor("shell", "context")),
  navCounts: () => Promise.resolve(notBackedFor("shell", "navCounts")),
  notifications: () => Promise.resolve(notBackedFor("shell", "notifications")),
  people: () => Promise.resolve(notBackedFor("shell", "people")),
  assistantEngine: () =>
    Promise.resolve(notBackedFor("shell", "assistantEngine")),
  recentRuns: () => Promise.resolve(notBackedFor("shell", "recentRuns")),
  account: () => Promise.resolve(notBackedFor("shell", "account")),
};
