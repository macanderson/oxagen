// These tests run the check over the repository root: the Caddyfile, the
// installer, and the node bootstrap as they stand. vitest.config.ts leaves
// *.tree.test.ts files out of turbo's cached tasks, so `pnpm check:tree-guards`
// runs them uncached in the checks job (#4664 item 2).
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP,
  CADDYFILE_ALB,
  CANONICAL_KEY,
  run,
} from "./check-caddy-config-pipeline.mjs";

describe("the repository as it stands", () => {
  it("has no proxy-trust list wide enough to hold a caller", () => {
    expect(run()).toEqual([]);
  });

  it("still substitutes the ALB subnets rather than naming them", () => {
    // Guards the check itself: if CADDYFILE_ALB ever pointed at a file with no
    // directive at all, every overbroad assertion in
    // check-caddy-config-pipeline.test.ts would vacuously pass against the
    // real repo while `run()` reported the missing directive.
    expect(run()).toEqual([]);
    expect(CADDYFILE_ALB).toBe("infra/tools/caddy/Caddyfile.alb");
  });

  it("reads the real installer and the real bootstrap, not a stale path", () => {
    // If either constant pointed at a file that no longer exists, run() would
    // throw rather than pass — but if one pointed at the WRONG file, every
    // ordering assertion in check-caddy-config-pipeline.test.ts would pass
    // vacuously against the real repo.
    expect(BOOTSTRAP).toBe("infra/modules/app-node/user-data.sh.tftpl");
    expect(CANONICAL_KEY).toBe("_caddy/Caddyfile");
    expect(run()).toEqual([]);
  });
});
