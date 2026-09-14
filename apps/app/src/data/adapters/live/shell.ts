// The live shell adapter. The context read waits on its kernel binding (WL-11)
// and returns the milestone and gap it waits on (src/data/backing.ts), never a
// fabricated value; the shell renders that honestly as a slug for the
// organization name and no switchers.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { ShellReadPort } from "@/data/ports";

export const liveShell: ShellReadPort = {
  context: () => Promise.resolve(notBackedFor("shell", "context")),
};
