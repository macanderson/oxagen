#!/usr/bin/env node
/**
 * Two invariants of the Caddy config pipeline that nothing else can catch.
 *
 * Both share a shape: the config is still valid, every script still runs, and
 * the damage appears somewhere other than where the mistake is.
 *
 * ## 1. A trusted-proxy list that can contain the caller is not a trusted-proxy list
 *
 * `infra/tools/caddy/Caddyfile.alb` declared `trusted_proxies static
 * private_ranges` with `trusted_proxies_strict`. On an INTERNET-FACING load
 * balancer that is a client-IP spoof:
 *
 *   1. A caller reaches the public ALB from an RFC1918 source — a workload in
 *      this VPC, a peered VPC, a VPN or Direct Connect client.
 *   2. The ALB appends the address it saw, so the CALLER's private address is
 *      now an entry in `X-Forwarded-For`.
 *   3. Strict mode walks from the right skipping entries inside the trusted
 *      ranges. `private_ranges` covers the caller's address, so it is skipped
 *      and the walk continues LEFT into the prefix the caller wrote.
 *   4. `{client_ip}` is therefore a value the caller chose. This Caddyfile
 *      writes it into `X-Oxagen-Client-Ip` and `X-Forwarded-For` as an address
 *      the edge vouched for, and the application feeds it to the IAM
 *      `ip_ranges` / `ip_allow` conditions, which ALLOW on a CIDR match.
 *
 * The security group is not the mitigation: it bounds who can connect to the
 * Caddy listener (the ALB alone) and says nothing about who can reach the ALB.
 *
 * The same mistake has a second spelling one layer up. `TRUSTED_PROXY_CIDRS` is
 * the application's own version of this list (`packages/oxagen/src/client-ip.ts`
 * walks it identically), and its registry placeholder is what an operator
 * copies out of `.env.example`. A placeholder of `10.0.0.0/8` teaches the
 * defect: any caller inside 10/8 is then skipped as a proxy and an entry
 * further left — one the caller wrote — is returned instead.
 *
 * Neither of these fails anything. Caddy parses `private_ranges` happily, the
 * app parses `10.0.0.0/8` happily, and the wrong answer is a well-formed
 * address.
 *
 * ## 2. The canonical object is published only after it validates
 *
 * `s3://<bucket>/_caddy/Caddyfile` is not merely this run's input. The node
 * bootstrap copies whatever sits under that key onto a brand-new node at boot
 * (`infra/modules/app-node/user-data.sh.tftpl`). So a render published before
 * `caddy validate` has accepted it makes every FUTURE node replacement the
 * blast radius of a syntax error: the node being installed keeps its previous
 * config and looks healthy, and the next node to come up — at a scale-out, or
 * after a replacement weeks later — takes the broken object and never serves.
 *
 * The installer's own placeholder guard is specific to `__ALB_SUBNET_CIDRS__`.
 * Every other way a render can be invalid is caught only by `caddy validate`,
 * which runs on the node. So the ordering is: upload a CANDIDATE key, validate
 * it there, promote to the canonical key only on success. A failed validation
 * must leave the canonical object untouched — not deleted, not half-written.
 *
 * The other end of the same defect is the bootstrap: it must validate what it
 * fetched BEFORE overwriting the placeholder, and must not swallow a reload
 * failure. Copying first leaves a node whose file on disk is broken while the
 * container still holds the old config in memory — it serves nothing, and the
 * next restart cannot start Caddy at all.
 *
 * Both are ORDERING properties of shell scripts, so they are asserted here as
 * text, the way check-restart-alarm and check-main-concurrency hold their
 * invariants still. `caddy validate` itself cannot run in CI — there is no
 * caddy binary and no Docker daemon — which is exactly why the pipeline has to
 * be arranged so the one place that CAN validate runs before the publish.
 *
 * Run by `pnpm check:contracts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CADDYFILE_ALB = "infra/tools/caddy/Caddyfile.alb";
export const CADDYFILE_EDGE = "infra/tools/caddy/Caddyfile";
export const INSTALLER = "infra/tools/install-node-scripts.sh";
export const REGISTRY = "packages/config/src/registry.ts";
export const BOOTSTRAP = "infra/modules/app-node/user-data.sh.tftpl";

/** The key the node bootstrap reads at boot. Publishing to it is the commit. */
export const CANONICAL_KEY = "_caddy/Caddyfile";

/** The substitution the installer performs; see that script and the Caddyfile. */
export const ALB_SUBNETS_PLACEHOLDER = "__ALB_SUBNET_CIDRS__";

/**
 * Spellings of "trust everything private" (or everything at all). Each one, put
 * in a proxy-trust list, can contain a caller.
 *
 * `private_ranges` is Caddy's own alias for the RFC1918 blocks plus loopback
 * and link-local. The literals are the same thing written out, which is how
 * this would come back after being removed by name.
 */
export const OVERBROAD_RANGES = [
  "private_ranges",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "0.0.0.0/0",
  "::/0",
];

/**
 * Every `trusted_proxies` directive in a Caddyfile, as the list of tokens it
 * names. `trusted_proxies_strict` takes no ranges and is not one of these.
 */
export function trustedProxyDirectives(caddyfile) {
  const directives = [];
  for (const rawLine of caddyfile.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^trusted_proxies\s+(.*)$/.exec(line);
    if (!match) continue;
    const tokens = match[1].trim().split(/\s+/).filter(Boolean);
    // `trusted_proxies static <ranges…>` — the module name is not a range.
    directives.push(tokens[0] === "static" ? tokens.slice(1) : tokens);
  }
  return directives;
}

/** Does this file declare strict mode, without which the list is not consulted? */
export function declaresStrictMode(caddyfile) {
  return caddyfile
    .split("\n")
    .some(
      (line) =>
        line.trim() === "trusted_proxies_strict" &&
        !line.trim().startsWith("#"),
    );
}

/** The `placeholder:` of one ENV_REGISTRY entry, or null when it has none. */
export function registryPlaceholder(registry, name) {
  const start = registry.indexOf(`${name}: {`);
  if (start === -1) return null;
  const end = registry.indexOf("\n  },", start);
  const block = registry.slice(start, end === -1 ? undefined : end);
  const match = /placeholder:\s*"([^"]*)"/.exec(block);
  return match ? match[1] : null;
}

/**
 * Index of the first line matching `re`, or -1. Ordering assertions below are
 * about which step happens first, so they compare these rather than testing
 * whether some string exists anywhere in the file.
 */
export function lineIndexOf(text, re) {
  return text.split("\n").findIndex((line) => re.test(line));
}

/** The remote script the installer sends to the node, if it can be found. */
export function remoteTemplate(installer) {
  const match = /<<'REMOTE_EOF'[^\n]*\n([\s\S]*?)\nREMOTE_EOF/.exec(installer);
  return match ? match[1] : null;
}

export const CADDY_BLOCK_OPEN = "# >>> caddy-install";
export const CADDY_BLOCK_CLOSE = "# <<< caddy-install";

/**
 * The Caddy install/reload block of the remote script, between its markers.
 *
 * The markers exist so this block can be EXECUTED on its own in a test, which
 * matters more here than another regex would. The defect it was fixed for is a
 * two-run chain — a reload fails, and the retry's `cmp` compares the render
 * against the file that failure left behind — and no amount of reading one
 * run's source decides a chain. The test runs this block twice against a
 * stubbed `docker` and asserts on what the SECOND run does.
 */
export function caddyInstallBlock(installer) {
  const remote = remoteTemplate(installer);
  if (remote === null) return null;
  const open = remote.indexOf(CADDY_BLOCK_OPEN);
  const close = remote.indexOf(CADDY_BLOCK_CLOSE);
  if (open === -1 || close === -1 || close < open) return null;
  return remote.slice(open + CADDY_BLOCK_OPEN.length, close).trim();
}

/**
 * Drop comment lines before scanning for suppressed failures.
 *
 * Without this the check fails on its own subject's documentation: the
 * bootstrap explains the defect by quoting the `caddy reload ... || true` it
 * replaced, and the fix for a checker that flags that would be to delete the
 * explanation — which is the opposite of what is wanted. Same reason
 * `trustedProxyDirectives` skips commented directives.
 */
export function withoutComments(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/**
 * Fold shell line-continuations into one logical line.
 *
 * Without this the suppression scans miss the exact form of the defect they
 * were written for. The bootstrap's original read
 *
 *     docker exec oxagen-caddy caddy reload \
 *       --config /etc/caddy/Caddyfile --adapter caddyfile || true
 *
 * — `caddy reload` on one line and `|| true` on the next, so a per-line regex
 * sees a reload with no suppression and a suppression with no reload, and
 * reports nothing. Found by mutation-testing this checker against the code it
 * replaced, which is the only way a blind spot of this shape shows up.
 */
export function joinContinuations(text) {
  return text.replace(/\\\n\s*/g, " ");
}

export function inspect({ alb, edge, installer, registry, bootstrap }) {
  const problems = [];

  // ── 1. No Caddyfile may trust a range wide enough to hold a caller ───────
  for (const [path, contents] of [
    [CADDYFILE_ALB, alb],
    [CADDYFILE_EDGE, edge],
  ]) {
    for (const ranges of trustedProxyDirectives(contents)) {
      for (const range of ranges) {
        if (OVERBROAD_RANGES.includes(range)) {
          problems.push(
            `${path}: trusted_proxies names \`${range}\`, which is wide enough to contain a caller. ` +
              `On an internet-facing ALB the caller's own private address is appended to X-Forwarded-For, ` +
              `strict mode then skips it as a proxy and walks into the prefix the caller wrote. ` +
              `Name the load balancer's own subnets instead.`,
          );
        }
      }
    }
  }

  // ── 2. The ALB file's list must stay a substitution with no fallback ─────
  const albDirectives = trustedProxyDirectives(alb);
  if (albDirectives.length === 0) {
    problems.push(
      `${CADDYFILE_ALB}: no trusted_proxies directive. Without one Caddy reads its immediate peer — the load balancer — as the client, and every caller shares one address.`,
    );
  } else {
    const namesPlaceholder = albDirectives.some((ranges) =>
      ranges.includes(ALB_SUBNETS_PLACEHOLDER),
    );
    if (!namesPlaceholder) {
      problems.push(
        `${CADDYFILE_ALB}: trusted_proxies no longer names ${ALB_SUBNETS_PLACEHOLDER}. The ALB's ENIs are per-AZ and change as it scales, so a literal list goes stale silently; the installer resolves the subnets it scales within on every run.`,
      );
    }
  }

  if (!declaresStrictMode(alb)) {
    problems.push(
      `${CADDYFILE_ALB}: trusted_proxies_strict is gone. Without it Caddy reads the LEFTMOST X-Forwarded-For entry, which is whatever the caller wrote — the list above stops being consulted and nothing fails.`,
    );
  }

  // ── 3. The installer must substitute it, and refuse to ship it unresolved ─
  if (!installer.includes(ALB_SUBNETS_PLACEHOLDER)) {
    problems.push(
      `${INSTALLER}: does not substitute ${ALB_SUBNETS_PLACEHOLDER}. The checked-in Caddyfile would reach the node verbatim.`,
    );
  }
  if (!/describe-load-balancers/.test(installer)) {
    problems.push(
      `${INSTALLER}: no longer resolves the trusted ranges from the live load balancer, so the list cannot be kept current.`,
    );
  }
  if (!/refusing to upload/.test(installer)) {
    problems.push(
      `${INSTALLER}: lost the guard that refuses to upload a rendered Caddyfile still containing a placeholder. An unsubstituted upload sits in S3 until the next node replacement picks it up.`,
    );
  }
  // A fallback is the whole hazard: every plausible default for "which proxies
  // are in front of me" is wider than the truth.
  if (
    OVERBROAD_RANGES.some((range) =>
      new RegExp(
        `${ALB_SUBNETS_PLACEHOLDER}[^\\n]*${range.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ).test(installer),
    )
  ) {
    problems.push(
      `${INSTALLER}: substitutes ${ALB_SUBNETS_PLACEHOLDER} with an overbroad default. Absent must fail the run, not widen the list back to where the review found it.`,
    );
  }

  // ── 4. The application-side list has the same failure mode ──────────────
  const placeholder = registryPlaceholder(registry, "TRUSTED_PROXY_CIDRS");
  if (placeholder === null) {
    problems.push(
      `${REGISTRY}: TRUSTED_PROXY_CIDRS has no placeholder, so .env.example offers no example of the shape this value must take.`,
    );
  } else {
    for (const range of placeholder.split(",").map((entry) => entry.trim())) {
      if (OVERBROAD_RANGES.includes(range)) {
        problems.push(
          `${REGISTRY}: the TRUSTED_PROXY_CIDRS placeholder is \`${range}\`, which is copied verbatim into .env.example. An operator who keeps it declares every host in that block a trusted proxy, so the identity walk skips any caller inside it and returns an entry further left — one the caller wrote. Use a concrete subnet.`,
        );
      }
    }
  }

  // ── 5. the canonical object is published only after validation ──────────
  const writesCanonical = new RegExp(
    `aws s3 cp [^\\n]*s3://[^\\s]*/${CANONICAL_KEY}(?:\\s|"|$)`,
  );
  const installerCode = joinContinuations(withoutComments(installer));
  // The Caddy block below is serialised with `flock`; a node without it would
  // fail that line and read as "no other install is running".
  if (!/for tool in [^\n]*\bflock\b/.test(installerCode)) {
    problems.push(
      `${INSTALLER}: \`flock\` is missing from the remote script's dependency check. The Caddy block depends on it to serialise concurrent installs, and a node without it would fail at the lock rather than at a named missing dependency.`,
    );
  }
  const publishAt = lineIndexOf(installerCode, writesCanonical);
  const successGateAt = lineIndexOf(installerCode, /\$st\s*!=\s*Success/);

  if (publishAt === -1) {
    problems.push(
      `${INSTALLER}: nothing writes s3://.../${CANONICAL_KEY}, so the node bootstrap has no config to fetch.`,
    );
  } else if (successGateAt === -1) {
    problems.push(
      `${INSTALLER}: no gate on the remote command's status, so the canonical object is published whether or not the node accepted the config.`,
    );
  } else if (publishAt < successGateAt) {
    problems.push(
      `${INSTALLER}: writes ${CANONICAL_KEY} (line ${publishAt + 1}) BEFORE the remote validation gate (line ${successGateAt + 1}). ` +
        `A render that fails \`caddy validate\` then sits under the key the bootstrap copies onto the next node to boot — this node keeps its old config and looks fine while the next replacement never serves. ` +
        `Upload a candidate, validate it on the node, and promote only after.`,
    );
  }

  // A failed run must leave the previous canonical object in place. Deleting it
  // would turn "the new config is bad" into "there is no config", which the
  // bootstrap reads as a first provision.
  if (
    new RegExp(`aws s3 rm [^\\n]*s3://[^\\s]*/${CANONICAL_KEY}`).test(
      installerCode,
    )
  ) {
    problems.push(
      `${INSTALLER}: deletes ${CANONICAL_KEY}. A failed publish must leave the previous object untouched; removing it makes the next node boot as if nothing had ever been published.`,
    );
  }

  const remote = remoteTemplate(installer);
  if (remote === null) {
    problems.push(
      `${INSTALLER}: no REMOTE_EOF heredoc — cannot tell what the node is asked to validate.`,
    );
  } else {
    if (!/caddy validate/.test(remote)) {
      problems.push(
        `${INSTALLER}: the remote script no longer runs \`caddy validate\`, which is the only check that sees a syntax error at all.`,
      );
    }
    const fetchAt = lineIndexOf(remote, /aws s3 cp [^\n]*Caddyfile/);
    const validateAt = lineIndexOf(remote, /caddy validate/);
    if (fetchAt !== -1 && validateAt !== -1 && validateAt < fetchAt) {
      problems.push(
        `${INSTALLER}: the remote script validates before it fetches, so it is validating something other than this run's render.`,
      );
    }
    if (new RegExp(`s3://__BUCKET__/${CANONICAL_KEY}`).test(remote)) {
      problems.push(
        `${INSTALLER}: the remote script validates ${CANONICAL_KEY} itself. That is the object it is supposed to be deciding whether to write — validating it after publishing proves nothing about what the next node boots.`,
      );
    }
  }

  // ── 6. the bootstrap validates before it destroys the placeholder ───────
  const bootCode = joinContinuations(withoutComments(bootstrap));
  const bootFetchAt = lineIndexOf(
    bootCode,
    new RegExp(`aws s3 cp [^\\n]*${CANONICAL_KEY}`),
  );
  if (bootFetchAt === -1) {
    problems.push(
      `${BOOTSTRAP}: no longer fetches ${CANONICAL_KEY}, so a replacement node comes back on the 503 placeholder for ever.`,
    );
  } else {
    const bootFetchLine = bootCode.split("\n")[bootFetchAt] ?? "";
    if (/\/opt\/oxagen\/caddy\/Caddyfile/.test(bootFetchLine)) {
      problems.push(
        `${BOOTSTRAP}: downloads ${CANONICAL_KEY} straight over /opt/oxagen/caddy/Caddyfile. ` +
          `An invalid object then destroys the 503 placeholder before anything has looked at it: the running container keeps the old config in memory while the file on disk is broken, so the node serves nothing and the next container restart cannot start Caddy at all. Fetch to a temp path and validate first.`,
      );
    }
    if (!/caddy validate/.test(bootCode)) {
      problems.push(
        `${BOOTSTRAP}: never validates the config it fetched. The installer's validation covers the node being installed, not this one.`,
      );
    }
  }

  // `|| true` on the reload erases the difference between "no config published
  // yet", which is normal on a first provision, and "the published config is
  // broken", which is an outage. Both then look like a quiet boot.
  if (/caddy reload[^\n]*\|\|\s*true/.test(bootCode)) {
    problems.push(
      `${BOOTSTRAP}: suppresses a \`caddy reload\` failure with \`|| true\`. A node that cannot load its config must say so — silence here is indistinguishable from a healthy boot.`,
    );
  }
  for (const line of bootCode.split("\n")) {
    if (/caddy validate/.test(line) && /\|\|\s*true/.test(line)) {
      problems.push(
        `${BOOTSTRAP}: suppresses a \`caddy validate\` failure with \`|| true\`, which makes the validation decide nothing.`,
      );
    }
  }

  // ── 7. neither half may leave an unaccepted config on disk ──────────────
  //
  // /opt/oxagen/caddy/Caddyfile is what the installer's `cmp -s` compares
  // against, so it has to mean "the config Caddy accepted". A config written
  // there and not accepted makes the next run report "caddy config unchanged",
  // skip the reload and promote the candidate as successful — while Caddy is
  // still running the old config that forwards a caller-supplied
  // x-oxagen-client-ip. Both halves write that file, so both are checked.
  //
  // These are shape assertions, not proofs: the behavioural proof is the test
  // that runs the block twice with a failing reload. What they stop is the
  // restore being deleted later by someone who reads it as belt-and-braces.
  const block = caddyInstallBlock(installer);
  if (block === null) {
    problems.push(
      `${INSTALLER}: the remote script's Caddy block is not delimited by \`${CADDY_BLOCK_OPEN}\` / \`${CADDY_BLOCK_CLOSE}\`. Those markers are what lets the retry-after-a-failed-reload case be executed as a test; without them that chain has no coverage at all.`,
    );
  } else {
    // Comments stripped for the same reason rule 6 strips them: this block
    // EXPLAINS the reload-ordering defect in prose, and a per-line scan over
    // the prose finds "caddy reload" above the copy and reports the defect the
    // comment is describing. The fix for that would be deleting the
    // explanation, which is backwards.
    const blockCode = joinContinuations(withoutComments(block));
    if (!/trap\s+\S+\s+EXIT/.test(blockCode)) {
      problems.push(
        `${INSTALLER}: the remote Caddy block installs no \`trap ... EXIT\`, so a failed \`caddy reload\` leaves the candidate on disk. The next run's \`cmp -s\` then reports it unchanged, skips the reload, and the caller promotes it as successful.`,
      );
    }
    const swapAt = lineIndexOf(
      blockCode,
      /cp .*Caddyfile\.incoming .*caddy\/Caddyfile/,
    );
    const reloadAt = lineIndexOf(blockCode, /caddy reload/);
    if (swapAt !== -1 && reloadAt !== -1 && swapAt > reloadAt) {
      problems.push(
        `${INSTALLER}: the remote Caddy block reloads before it installs the candidate, so the reload is testing the previous config.`,
      );
    }
    if (!/rm -f \/opt\/oxagen\/caddy\/Caddyfile\b/.test(blockCode)) {
      problems.push(
        `${INSTALLER}: the remote Caddy block never removes the candidate on a FIRST install whose reload failed. There is no accepted config to restore there, so leaving it is the same defect by another route.`,
      );
    }

    // ── The block runs alone on the node ────────────────────────────────────
    //
    // `/tmp/Caddyfile.incoming` is a fixed path and the live config, its
    // `.prev` and the running Caddy process ARE the node — none of them can be
    // given a per-run copy. Two invocations therefore have to be serialised or
    // one validates bytes the other downloaded and its caller promotes a
    // candidate no node ever checked. The behavioural proof is the test that
    // runs this block twice concurrently; these hold the shape still.
    const lockAt = lineIndexOf(blockCode, /flock\s+(-\S+\s+)*-x|flock\s+-x/);
    const fetchAt = lineIndexOf(blockCode, /aws s3 cp .*Caddyfile\.incoming/);
    if (lockAt === -1) {
      problems.push(
        `${INSTALLER}: the remote Caddy block takes no exclusive \`flock\`, so two installs on one node share /tmp/Caddyfile.incoming and the live config. One run can then validate and reload the OTHER run's bytes, exit 0, and have its caller promote the candidate it downloaded — publishing a render nothing validated and the node is not running.`,
      );
    } else if (fetchAt !== -1 && lockAt > fetchAt) {
      problems.push(
        `${INSTALLER}: the remote Caddy block fetches the candidate before it takes the lock, so the staging file is already shared by the time the lock is held. The lock has to cover fetch, validate, swap and reload together or it covers nothing.`,
      );
    }
    // The release must be process exit and nothing sooner. bash runs EXIT traps
    // BEFORE the process exits, so `caddy_restore_if_unaccepted` runs inside the
    // critical section; an early release moves the rollback path into the race
    // instead of the swap, which is the worse of the two failures.
    if (/flock\s+-u|exec\s+\d+>&-/.test(blockCode)) {
      problems.push(
        `${INSTALLER}: the remote Caddy block releases its lock explicitly. It must be released by process exit alone, so the \`trap ... EXIT\` restore still holds it — otherwise a rollback can overwrite a file another run is midway through staging, which is worse than the interleaving the lock was added for.`,
      );
    }
  }
  if (/caddy reload/.test(bootCode)) {
    const bootReloadAt = lineIndexOf(bootCode, /caddy reload/);
    const bootRestoreAt = lineIndexOf(
      bootCode,
      /cp [^\n]*Caddyfile\.accepted \/opt\/oxagen\/caddy\/Caddyfile/,
    );
    if (bootRestoreAt === -1 || bootRestoreAt < bootReloadAt) {
      problems.push(
        `${BOOTSTRAP}: a validated config whose \`caddy reload\` fails is left on /opt/oxagen/caddy/Caddyfile while the running process keeps the old one. The installer reads that file as "what Caddy accepted", so the next install reports it unchanged and promotes without ever reloading. Restore the running config on the failure branch.`,
      );
    }
  }

  return problems;
}

export function run(root = repoRoot) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  return inspect({
    alb: read(CADDYFILE_ALB),
    edge: read(CADDYFILE_EDGE),
    installer: read(INSTALLER),
    registry: read(REGISTRY),
    bootstrap: read(BOOTSTRAP),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = run();
  if (problems.length > 0) {
    console.error(
      "check-caddy-config-pipeline: the Caddy config pipeline has a hole\n",
    );
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    "check-caddy-config-pipeline: trust lists name proxies, and the canonical config is published only after it validates",
  );
}
