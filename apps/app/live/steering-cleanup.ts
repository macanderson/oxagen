/**
 * The workflow's cleanup steps for the steering live test.
 *
 *   tsx live/steering-cleanup.ts sweep   before the suite: clears what earlier runs left
 *   tsx live/steering-cleanup.ts run     after the suite: clears this run's workspace and repo
 *
 * It exits 1 when any cleanup failed or sign-in failed, and 2 on a usage error.
 * A failed sign-in still lets it delete repositories with the GitHub token.
 */
import {
  cleanupRun,
  githubRig,
  messageOf,
  readSettings,
  sweepOld,
  trySignIn,
} from "./steering-rig";

const mode = process.argv[2];

if (mode !== "sweep" && mode !== "run") {
  console.error("Usage: tsx live/steering-cleanup.ts sweep|run");
  process.exitCode = 2;
} else {
  try {
    const settings = readSettings();
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
