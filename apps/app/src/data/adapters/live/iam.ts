// The live iam adapter. Batch 3 lane A8 (org + members + keys (roles)) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { IamReadPort } from "@/data/ports";

export const liveIam: IamReadPort = {
  roles: () => Promise.resolve(notBackedFor("iam", "roles")),
  permissionCatalog: () =>
    Promise.resolve(notBackedFor("iam", "permissionCatalog")),
};
