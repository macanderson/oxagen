// Test support for unit tests and stories that render against fixture data
// (the fixture ban exempts *.test.* and *.stories.*; nothing else imports this).
// A source built here pins its state switches instead of reading cookies, so a
// test walks the loading, error, denied and engine-down states directly.
import type { DataSource, ShellReadPort } from "@/data/ports";
import { type FixtureOptions, createFixtureSource } from "./index";
import { seed } from "./seed";
import { DEFAULT_SHELL_SWITCHES, type ShellSwitches } from "./state";

/** The instant the seed is read at in tests: the demo record's clock. */
export const FIXTURE_TEST_NOW = Date.parse("2026-09-12T16:00:00Z");

export function testFixtureSource(
  options: {
    /** An `mc_state` value, e.g. `fleet:error` or `assistant:down`. */
    state?: string;
    shell?: ShellSwitches;
  } & Partial<FixtureOptions> = {},
): DataSource {
  const { state, shell = DEFAULT_SHELL_SWITCHES, ...overrides } = options;
  return createFixtureSource({
    seed,
    readState: () => Promise.resolve(state),
    readShellSwitches: () => Promise.resolve(shell),
    honourSwitches: true,
    loadingMs: 0,
    sleep: () => Promise.resolve(),
    now: () => FIXTURE_TEST_NOW,
    ...overrides,
  });
}

/** The fixture shell port with the given engine and notification switches. */
export function testFixtureShell(
  shell: ShellSwitches = DEFAULT_SHELL_SWITCHES,
): ShellReadPort {
  return testFixtureSource({ shell }).shell;
}
