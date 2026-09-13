// The live org adapter. Batch 3 lane A8 (org + members + keys) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { OrgReadPort } from "@/data/ports";

export const liveOrg: OrgReadPort = {
  organization: () => Promise.resolve(notBackedFor("org", "organization")),
  members: () => Promise.resolve(notBackedFor("org", "members")),
  invitations: () => Promise.resolve(notBackedFor("org", "invitations")),
  workspaces: () => Promise.resolve(notBackedFor("org", "workspaces")),
  apiKeys: () => Promise.resolve(notBackedFor("org", "apiKeys")),
  dataPlanes: () => Promise.resolve(notBackedFor("org", "dataPlanes")),
  modelFunding: () => Promise.resolve(notBackedFor("org", "modelFunding")),
};
