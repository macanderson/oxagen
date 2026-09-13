// The live shell adapter. Batch 3 lane A10 (audit + shell) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { ShellReadPort } from "@/data/ports";

export const liveShell: ShellReadPort = {
  notifications: () => Promise.resolve(notBackedFor("shell", "notifications")),
  people: () => Promise.resolve(notBackedFor("shell", "people")),
  assistantEngine: () =>
    Promise.resolve(notBackedFor("shell", "assistantEngine")),
};
