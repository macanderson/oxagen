/**
 * The MCP Studio live suite's global teardown. `teardownSuite` archives the
 * run's workspace and deletes its steering repo, pass or fail.
 */
import { MCP_STUDIO_SUITE, teardownSuite } from "./steering-rig";

export default function teardown(): Promise<void> {
  return teardownSuite(MCP_STUDIO_SUITE);
}
