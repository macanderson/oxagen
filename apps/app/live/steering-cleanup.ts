/**
 * The workflow's cleanup steps for the live suites that share the steering rig.
 *
 *   tsx live/steering-cleanup.ts sweep [suite]   before the suite: clears what earlier runs left
 *   tsx live/steering-cleanup.ts run [suite]     after the suite: clears this run's workspace and repo
 *
 * The suite is `steering` (the default) or `mcp-studio`. Each one touches only
 * the workspaces and repositories its own prefix names.
 *
 * It exits 1 when any cleanup failed or sign-in failed, and 2 on a usage error.
 * A failed sign-in still lets it delete repositories with the GitHub token.
 */
import {
  cleanupRun,
  githubRig,
  type LiveSuite,
  MCP_STUDIO_SUITE,
  messageOf,
  readSettings,
  STEERING_SUITE,
  sweepOld,
  trySignIn,
} from "./steering-rig";

const SUITES: Record<string, LiveSuite> = {
  steering: STEERING_SUITE,
  "mcp-studio": MCP_STUDIO_SUITE,
};

const mode = process.argv[2];
const suite = SUITES[process.argv[3] ?? "steering"];

if ((mode !== "sweep" && mode !== "run") || suite === undefined) {
  console.error("Usage: tsx live/steering-cleanup.ts sweep|run [steering|mcp-studio]");
  process.exitCode = 2;
} else {
  try {
    const settings = readSettings(process.env, suite);
    const { ox, problem } = await trySignIn(settings);
    if (problem !== null) {
      console.error(`Sign-in failed, so workspaces stay active: ${problem}`);
      process.exitCode = 1;
    }
    const gh = githubRig(settings.githubToken);
    const done =
      mode === "sweep" ? await sweepOld(ox, gh, settings) : await cleanupRun(ox, gh, settings);
    for (const line of done) console.log(line);
    if (done.length === 0) console.log("Nothing to clean up.");
  } catch (error) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}
