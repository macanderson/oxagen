/**
 * The live suite's global teardown. It archives the run's workspace and
 * deletes its steering repo, pass or fail. The workflow's always() step runs
 * the same cleanup again, which covers a teardown that never ran, such as a
 * job cancelled mid-suite.
 */
import { cleanupRun, githubRig, readSettings, trySignIn } from "./steering-rig";

export default async function teardown(): Promise<void> {
  const settings = readSettings();
  const { ox, problem } = await trySignIn(settings);
  if (problem !== null) {
    console.error(`Teardown could not sign in, so the workspace stays active: ${problem}`);
  }
  const done = await cleanupRun(ox, githubRig(settings.githubToken), settings);
  for (const line of done) console.log(line);
}
