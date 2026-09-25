// context.steering.deps.ts — what the steering handlers are built from
// (ADR-061): the Postgres store, the repository host seam (GitHub or GitLab), the role reader and the
// clock. `steeringDeps()` wires the real ones; the tests pass fakes.
import {
  resolveActorOrgRole,
  resolveActorWorkspaceRole,
} from "@oxagen/iam/org-role";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { SecurityEventInput } from "@oxagen/telemetry";
import type { SteeringHost } from "./context.steering.github";
import { createSteeringHost } from "./context.steering.host";
import {
  postgresSteeringStore,
  type SteeringStore,
} from "./context.steering.store";
import { syncDeps, syncWorkspaceSteering } from "./context.steering.sync";

interface RoleReader {
  orgRole(orgId: string, userId: string): Promise<string | null>;
  workspaceRole(
    orgId: string,
    workspaceId: string,
    userId: string,
  ): Promise<string | null>;
}

export interface SteeringDeps {
  store: SteeringStore;
  github: SteeringHost;
  roles: RoleReader;
  now: () => Date;
  emit: (event: SecurityEventInput) => void;
  /**
   * Run the repository sync now (ADR-182). A Context PR the host merged at a
   * commit Oxagen never checked is published from the production branch by
   * the sync, and a person pressing Merge on it should not wait for the
   * webhook. Absent in tests that do not exercise it.
   */
  sync?: (scope: { orgId: string; workspaceId: string }) => Promise<unknown>;
}

export function steeringDeps(): SteeringDeps {
  return {
    store: postgresSteeringStore,
    github: createSteeringHost(),
    roles: {
      orgRole: resolveActorOrgRole,
      workspaceRole: resolveActorWorkspaceRole,
    },
    now: () => new Date(),
    emit: emitSecurityEvent,
    sync: (scope) => syncWorkspaceSteering(syncDeps(), scope, { force: true }),
  };
}
