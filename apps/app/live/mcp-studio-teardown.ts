/**
 * The MCP Studio live suite's global teardown. It runs once, after every
 * test, pass or fail.
 *
 * It stops the relay process first. The teardown archives the workspace, so
 * a relay a failed run never revoked is left registered where nothing routes
 * to it. Stopping the process ends its connection before the job stops the
 * sample servers. This runs here and not in a test.afterAll, because
 * Playwright runs afterAll each time it replaces the worker after a failed
 * test, which stopped the relay before the revocation test could use it
 * (#5139).
 *
 * Then `teardownSuite` archives the run's workspace and deletes its steering
 * repo, even when the relay did not stop.
 */
import { control, readStudioSettings } from "./mcp-studio-rig";
import { MCP_STUDIO_SUITE, teardownSuite } from "./steering-rig";

export default async function teardown(): Promise<void> {
  try {
    await control(readStudioSettings()).stopRelay();
  } finally {
    await teardownSuite(MCP_STUDIO_SUITE);
  }
}
