// Selects the shell's read adapter and the signed-in user, mirroring
// src/data/source.ts (plan §4.5): fixture data is for dev, Storybook and e2e
// only and is never reachable in a production build (`isFixtureMode` is
// constant-folded to false there, so the dynamic import below is dropped).
//
// PROMOTE: fold into src/data/source.ts (lane L1) as `dataSource().shell`, and
// take the user from `requireViewer` (lane L4) instead of the fixture cookie.
import "server-only";
import { cookies } from "next/headers";
import {
  FIXTURE_SESSION_COOKIE,
  isFixtureMode,
  readFixtureSession,
} from "@/server/fixture-session";
import { liveShell } from "./adapters/live";
import {
  SHELL_ENGINE_COOKIE,
  SHELL_NOTIFICATIONS_COOKIE,
  parseShellSwitches,
} from "./fixture-switches";
import type { ShellReadPort } from "./port";

export type ShellSource = {
  port: ShellReadPort;
  /** The signed-in user's id, or null when no session could be read. */
  userId: string | null;
};

export async function shellSource(): Promise<ShellSource> {
  if (isFixtureMode()) {
    const jar = await cookies();
    const session = readFixtureSession(jar.get(FIXTURE_SESSION_COOKIE)?.value);
    const { fixtureShell } = await import("./adapters/fixture");
    const switches = parseShellSwitches({
      engine: jar.get(SHELL_ENGINE_COOKIE)?.value,
      notifications: jar.get(SHELL_NOTIFICATIONS_COOKIE)?.value,
    });
    return { port: fixtureShell(switches), userId: session?.user.id ?? null };
  }
  return { port: liveShell, userId: null };
}
