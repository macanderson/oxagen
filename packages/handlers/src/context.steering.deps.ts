// context.steering.deps.ts — what the steering handlers are built from
// (ADR-061): the Postgres store, the GitHub seam, the role reader and the
// clock. `steeringDeps()` wires the real ones; the tests pass fakes.
import {
  resolveActorOrgRole,
  resolveActorWorkspaceRole,
} from "@oxagen/iam/org-role";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { SecurityEventInput } from "@oxagen/telemetry";
import {
  createSteeringGitHub,
  type SteeringGitHub,
} from "./context.steering.github";
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
  github: SteeringGitHub;
  roles: RoleReader;
  now: () => Date;
  emit: (event: SecurityEventInput) => void;
}

export function steeringDeps(): SteeringDeps {
  return {
    store: postgresSteeringStore,
    github: createSteeringGitHub(),
    roles: {
      orgRole: resolveActorOrgRole,
      workspaceRole: resolveActorWorkspaceRole,
    },
    now: () => new Date(),
    emit: emitSecurityEvent,
  };
}
