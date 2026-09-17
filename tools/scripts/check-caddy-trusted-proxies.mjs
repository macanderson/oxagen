#!/usr/bin/env node
/**
 * A trusted-proxy list that can contain the caller is not a trusted-proxy list.
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
 * address. So it is asserted here as text, the way check-restart-alarm and
 * check-main-concurrency hold their invariants still.
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
        line.trim() === "trusted_proxies_strict" && !line.trim().startsWith("#"),
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

export function inspect({ alb, edge, installer, registry }) {
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

  return problems;
}

export function run(root = repoRoot) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  return inspect({
    alb: read(CADDYFILE_ALB),
    edge: read(CADDYFILE_EDGE),
    installer: read(INSTALLER),
    registry: read(REGISTRY),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = run();
  if (problems.length > 0) {
    console.error(
      "check-caddy-trusted-proxies: a proxy-trust list can contain the caller\n",
    );
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    "check-caddy-trusted-proxies: every proxy-trust list names proxies, not ranges that could hold a caller",
  );
}
