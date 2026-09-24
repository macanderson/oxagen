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
  };
}
