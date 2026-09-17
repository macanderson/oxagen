/**
 * What these tests would still pass on, because "it fails when I break the
 * code" only shows the assertion is sensitive to the change, not that it
 * measures the thing that matters.
 *
 * The thing that matters is that no proxy-trust list in this repo is wide
 * enough to contain a caller. Every case below is written against a specific
 * way that stops being true while the Caddyfile still parses, the installer
 * still runs, and the app still starts — which is the whole difficulty: the
 * wrong answer is a well-formed IP address.
 */
import { describe, expect, it } from "vitest";

import {
  ALB_SUBNETS_PLACEHOLDER,
  CADDYFILE_ALB,
  declaresStrictMode,
  inspect,
  OVERBROAD_RANGES,
  registryPlaceholder,
  run,
  trustedProxyDirectives,
} from "./check-caddy-trusted-proxies.mjs";

/** A repo state that passes, so each case can break exactly one thing. */
function healthy() {
  return {
    alb: [
      "# trusted_proxies static private_ranges  <- a comment, not a directive",
      "{",
      "\tservers {",
      `\t\ttrusted_proxies static ${ALB_SUBNETS_PLACEHOLDER}`,
      "\t\ttrusted_proxies_strict",
      "\t}",
      "}",
    ].join("\n"),
    edge: "app.oxagen.sh {\n\treverse_proxy 127.0.0.1:3000\n}\n",
    installer: [
      `sed "s|${ALB_SUBNETS_PLACEHOLDER}|$cidrs|" "$src" > "$out"`,
      "aws elbv2 describe-load-balancers --names oxagen-app",
      'echo "refusing to upload" >&2',
    ].join("\n"),
    registry: [
      "  TRUSTED_PROXY_CIDRS: {",
      '    description: "…",',
      '    placeholder: "10.60.0.0/20,10.60.16.0/20",',
      "  },",
    ].join("\n"),
  };
}

describe("trustedProxyDirectives", () => {
  it("reads the ranges off a directive, dropping the module name", () => {
    // `static` is the module that holds the list; treating it as a range would
    // make every assertion below scan one token that can never match.
    expect(
      trustedProxyDirectives(
        "\t\ttrusted_proxies static 10.60.0.0/20 10.60.16.0/20",
      ),
    ).toEqual([["10.60.0.0/20", "10.60.16.0/20"]]);
  });

  it("ignores a commented-out directive", () => {
    // The file explains the defect by naming `private_ranges` in prose. A
    // scanner that matched comments would fail on its own documentation, and
    // the fix for that would be to delete the explanation.
    expect(
      trustedProxyDirectives("# trusted_proxies static private_ranges"),
    ).toEqual([]);
  });

  it("does not mistake trusted_proxies_strict for a list", () => {
    // It takes no ranges. Reading it as one would make `strict` a "range" and
    // quietly change what the overbroad check is scanning.
    expect(trustedProxyDirectives("\ttrusted_proxies_strict")).toEqual([]);
  });
});

describe("declaresStrictMode", () => {
  it("is false when only the commented form survives", () => {
    expect(declaresStrictMode("# trusted_proxies_strict")).toBe(false);
    expect(declaresStrictMode("\ttrusted_proxies_strict")).toBe(true);
  });
});

describe("registryPlaceholder", () => {
  it("reads the placeholder of the named entry and not a neighbour's", () => {
    const registry = [
      "  TRUSTED_PROXY_CIDRS: {",
      '    placeholder: "10.60.0.0/20",',
      "  },",
      "",
      "  TRUST_EDGE_CLIENT_IP_HEADER: {",
      '    placeholder: "false",',
      "  },",
    ].join("\n");
    expect(registryPlaceholder(registry, "TRUSTED_PROXY_CIDRS")).toBe(
      "10.60.0.0/20",
    );
    expect(registryPlaceholder(registry, "TRUST_EDGE_CLIENT_IP_HEADER")).toBe(
      "false",
    );
  });
});

describe("inspect", () => {
  it("passes the healthy shape", () => {
    expect(inspect(healthy())).toEqual([]);
  });

  // The P1 itself. Each of these is a valid Caddy config that serves traffic.
  for (const range of OVERBROAD_RANGES) {
    it(`rejects a Caddy trust list naming ${range}`, () => {
      const repo = healthy();
      repo.alb = repo.alb.replace(ALB_SUBNETS_PLACEHOLDER, range);
      const problems = inspect(repo);
      expect(problems.join("\n")).toContain(range);
      expect(problems.join("\n")).toContain("contain a caller");
    });
  }

  it("rejects an overbroad range hidden among good ones", () => {
    // The realistic regression is not a rewrite, it is an append: someone adds
    // a range to fix a client IP that stopped resolving. A check that only
    // looked at the first token would pass this.
    const repo = healthy();
    repo.alb = repo.alb.replace(
      ALB_SUBNETS_PLACEHOLDER,
      "10.60.0.0/20 10.60.16.0/20 192.168.0.0/16",
    );
    expect(inspect(repo).join("\n")).toContain("192.168.0.0/16");
  });

  it("rejects losing strict mode, which silently stops the list being read", () => {
    // Caddy then reads the LEFTMOST entry — the caller's — and the narrow list
    // above becomes decoration. Nothing errors; the config is still valid.
    const repo = healthy();
    repo.alb = repo.alb.replace(
      "\t\ttrusted_proxies_strict",
      "\t\t# trusted_proxies_strict",
    );
    expect(inspect(repo).join("\n")).toContain(
      "trusted_proxies_strict is gone",
    );
  });

  it("rejects dropping the trusted_proxies directive altogether", () => {
    const repo = healthy();
    repo.alb = repo.alb.replace(
      `\t\ttrusted_proxies static ${ALB_SUBNETS_PLACEHOLDER}\n`,
      "",
    );
    expect(inspect(repo).join("\n")).toContain("no trusted_proxies directive");
  });

  it("rejects a hardcoded list in place of the substitution", () => {
    // The ALB's ENIs are per-AZ and change as it scales. A literal list looks
    // right the day it is written and goes stale without any signal.
    const repo = healthy();
    repo.alb = repo.alb.replace(
      ALB_SUBNETS_PLACEHOLDER,
      "10.60.0.4 10.60.16.9",
    );
    expect(inspect(repo).join("\n")).toContain(ALB_SUBNETS_PLACEHOLDER);
  });

  it("rejects an installer that no longer substitutes the placeholder", () => {
    const repo = healthy();
    repo.installer = repo.installer.replace(
      `sed "s|${ALB_SUBNETS_PLACEHOLDER}|$cidrs|" "$src" > "$out"`,
      'cp "$src" "$out"',
    );
    expect(inspect(repo).join("\n")).toContain("does not substitute");
  });

  it("rejects an installer that stops resolving the ranges from the live ALB", () => {
    const repo = healthy();
    repo.installer = repo.installer.replace(
      "aws elbv2 describe-load-balancers --names oxagen-app",
      'cidrs="10.60.0.0/20"',
    );
    expect(inspect(repo).join("\n")).toContain("kept current");
  });

  it("rejects losing the guard against uploading an unsubstituted file", () => {
    // `caddy validate` on the node would also reject it, but only after the
    // object is in S3, where the next node replacement picks it up.
    const repo = healthy();
    repo.installer = repo.installer.replace(
      'echo "refusing to upload" >&2',
      "",
    );
    expect(inspect(repo).join("\n")).toContain("refuses to upload");
  });

  it("rejects a fallback that widens the list when resolution fails", () => {
    // The tempting fix for a failing lookup, and the one that restores the
    // vulnerability in full.
    const repo = healthy();
    repo.installer += `\ncidrs="\${cidrs:-private_ranges}"; sed "s|${ALB_SUBNETS_PLACEHOLDER}|private_ranges|"`;
    expect(inspect(repo).join("\n")).toContain("overbroad default");
  });

  // The second spelling, one layer up: the value an operator copies.
  it("rejects an RFC1918 supernet as the TRUSTED_PROXY_CIDRS placeholder", () => {
    const repo = healthy();
    repo.registry = repo.registry.replace(
      '"10.60.0.0/20,10.60.16.0/20"',
      '"10.0.0.0/8"',
    );
    const problems = inspect(repo).join("\n");
    expect(problems).toContain("10.0.0.0/8");
    expect(problems).toContain(".env.example");
  });

  it("rejects an overbroad entry appended to the placeholder list", () => {
    const repo = healthy();
    repo.registry = repo.registry.replace(
      '"10.60.0.0/20,10.60.16.0/20"',
      '"10.60.0.0/20, 172.16.0.0/12"',
    );
    expect(inspect(repo).join("\n")).toContain("172.16.0.0/12");
  });
});

describe("the repository as it stands", () => {
  it("has no proxy-trust list wide enough to hold a caller", () => {
    expect(run()).toEqual([]);
  });

  it("still substitutes the ALB subnets rather than naming them", () => {
    // Guards the check itself: if CADDYFILE_ALB ever pointed at a file with no
    // directive at all, every overbroad assertion above would vacuously pass
    // against the real repo while `run()` reported the missing directive.
    expect(run()).toEqual([]);
    expect(CADDYFILE_ALB).toBe("infra/tools/caddy/Caddyfile.alb");
  });
});
