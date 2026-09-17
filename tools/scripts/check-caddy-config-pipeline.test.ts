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
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALB_SUBNETS_PLACEHOLDER,
  BOOTSTRAP,
  CADDYFILE_ALB,
  caddyInstallBlock,
  CANONICAL_KEY,
  INSTALLER,
  joinContinuations,
  lineIndexOf,
  remoteTemplate,
  withoutComments,
  declaresStrictMode,
  inspect,
  OVERBROAD_RANGES,
  registryPlaceholder,
  run,
  trustedProxyDirectives,
} from "./check-caddy-config-pipeline.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
      'aws s3 cp "$RENDERED" "s3://$BUCKET/$CANDIDATE_KEY" --region "$REGION"',
      "read -r -d '' REMOTE_TEMPLATE <<'REMOTE_EOF' || true",
      "# >>> caddy-install",
      "aws s3 cp s3://__BUCKET__/__CANDIDATE_KEY__ /tmp/Caddyfile.incoming --region __REGION__",
      "docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile",
      "trap caddy_restore_if_unaccepted EXIT",
      "rm -f /opt/oxagen/caddy/Caddyfile",
      "cp /tmp/Caddyfile.incoming /opt/oxagen/caddy/Caddyfile",
      "docker exec oxagen-caddy caddy reload --config /etc/caddy/Caddyfile",
      "# <<< caddy-install",
      "REMOTE_EOF",
      "if [[ $st != Success ]]; then",
      "  exit 1",
      "fi",
      `aws s3 cp "s3://$BUCKET/$CANDIDATE_KEY" "s3://$BUCKET/${CANONICAL_KEY}" --region "$REGION"`,
    ].join("\n"),
    registry: [
      "  TRUSTED_PROXY_CIDRS: {",
      '    description: "…",',
      '    placeholder: "10.60.0.0/20,10.60.16.0/20",',
      "  },",
    ].join("\n"),
    bootstrap: [
      "# it used to be: docker exec oxagen-caddy caddy reload ... || true",
      `if aws s3 cp "s3://\${deploy_bucket}/${CANONICAL_KEY}" /tmp/Caddyfile.incoming --region "$REGION"; then`,
      "  if docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile; then",
      "    cp /opt/oxagen/caddy/Caddyfile /tmp/Caddyfile.accepted",
      "    cp /tmp/Caddyfile.incoming /opt/oxagen/caddy/Caddyfile",
      "    if docker exec oxagen-caddy caddy reload --config /etc/caddy/Caddyfile; then",
      '      echo "reloaded"',
      "    else",
      "      cp /tmp/Caddyfile.accepted /opt/oxagen/caddy/Caddyfile",
      '      echo "RELOAD FAILED" >&2',
      "    fi",
      "  fi",
      "fi",
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

describe("publish ordering", () => {
  // The finding this section exists for: the installer published the canonical
  // object BEFORE the node had validated it. The node being installed keeps its
  // previous config and looks healthy; the next node to boot takes the broken
  // object and never serves. The mistake and the damage are weeks apart.

  it("rejects publishing the canonical key before the validation gate", () => {
    const repo = healthy();
    const lines = repo.installer.split("\n");
    const publish = lines.pop() as string;
    // Same script, same commands, only the order changed — which is the whole
    // defect, so the check must be sensitive to order and nothing else.
    repo.installer = [lines[0], publish, ...lines.slice(1)].join("\n");
    const problems = inspect(repo).join("\n");
    expect(problems).toContain("BEFORE the remote validation gate");
  });

  it("rejects losing the validation gate entirely", () => {
    const repo = healthy();
    repo.installer = repo.installer.replace(
      "if [[ $st != Success ]]; then",
      "",
    );
    expect(inspect(repo).join("\n")).toContain(
      "no gate on the remote command's status",
    );
  });

  it("rejects a remote script that validates the canonical object itself", () => {
    // Validating what you have already published proves nothing about what the
    // next node boots — it is the object under test, not a candidate.
    const repo = healthy();
    repo.installer = repo.installer.replace(
      "s3://__BUCKET__/__CANDIDATE_KEY__",
      `s3://__BUCKET__/${CANONICAL_KEY}`,
    );
    expect(inspect(repo).join("\n")).toContain(
      "validates _caddy/Caddyfile itself",
    );
  });

  it("rejects a remote script that no longer validates at all", () => {
    const repo = healthy();
    repo.installer = repo.installer.replace(
      "docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile",
      "true",
    );
    expect(inspect(repo).join("\n")).toContain("no longer runs");
  });

  it("rejects validating before fetching", () => {
    const repo = healthy();
    repo.installer = repo.installer.replace(
      "aws s3 cp s3://__BUCKET__/__CANDIDATE_KEY__ /tmp/Caddyfile.incoming --region __REGION__\ndocker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile",
      "docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile\naws s3 cp s3://__BUCKET__/__CANDIDATE_KEY__ /tmp/Caddyfile.incoming --region __REGION__",
    );
    expect(inspect(repo).join("\n")).toContain("validates before it fetches");
  });

  it("rejects deleting the canonical object on a failed run", () => {
    // "The new config is bad" must not become "there is no config" — the
    // bootstrap reads an absent object as a first provision and stays on the
    // placeholder for ever.
    const repo = healthy();
    repo.installer += `\naws s3 rm "s3://$BUCKET/${CANONICAL_KEY}"`;
    expect(inspect(repo).join("\n")).toContain("deletes _caddy/Caddyfile");
  });

  it("rejects publishing nothing at all", () => {
    const repo = healthy();
    repo.installer = repo.installer
      .split("\n")
      .filter((l) => !l.includes(`/${CANONICAL_KEY}"`))
      .join("\n");
    expect(inspect(repo).join("\n")).toContain("has no config to fetch");
  });
});

describe("the bootstrap, which is the other end of the same defect", () => {
  it("rejects downloading straight over the live config", () => {
    // This is what made the publish-ordering bug reach production: an invalid
    // object destroys the 503 placeholder before anything looks at it.
    const repo = healthy();
    repo.bootstrap = repo.bootstrap.replace(
      "/tmp/Caddyfile.incoming --region",
      "/opt/oxagen/caddy/Caddyfile --region",
    );
    expect(inspect(repo).join("\n")).toContain("straight over");
  });

  it("rejects a bootstrap that never validates what it fetched", () => {
    // The installer's validation covers the node being installed, not this one.
    const repo = healthy();
    repo.bootstrap = repo.bootstrap.replace(
      "docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile",
      "true",
    );
    expect(inspect(repo).join("\n")).toContain("never validates");
  });

  it("rejects suppressing a reload failure", () => {
    const repo = healthy();
    repo.bootstrap = repo.bootstrap.replace(
      "    if docker exec oxagen-caddy caddy reload --config /etc/caddy/Caddyfile; then",
      "    docker exec oxagen-caddy caddy reload --config /etc/caddy/Caddyfile || true",
    );
    expect(inspect(repo).join("\n")).toContain("|| true");
  });

  it("rejects suppressing a validation failure", () => {
    const repo = healthy();
    repo.bootstrap = repo.bootstrap.replace(
      "  if docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile; then",
      "  docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile || true",
    );
    expect(inspect(repo).join("\n")).toContain("decide nothing");
  });

  it("rejects dropping the fetch, which strands a replacement on the placeholder", () => {
    const repo = healthy();
    repo.bootstrap = repo.bootstrap
      .split("\n")
      .filter((l) => !l.includes("aws s3 cp"))
      .join("\n");
    expect(inspect(repo).join("\n")).toContain(
      "comes back on the 503 placeholder",
    );
  });
});

describe("joinContinuations", () => {
  // This exists because mutation-testing the checker against the code it
  // replaced found it silent. The bootstrap's original form put `caddy reload`
  // on one line and `|| true` on the next, so a per-line scan saw a reload with
  // no suppression and a suppression with no reload, and reported nothing — a
  // checker that misses the exact defect it was written for.
  it("folds a continuation so a split `|| true` is still seen", () => {
    const split =
      "docker exec oxagen-caddy caddy reload \\\n  --config /etc/caddy/Caddyfile || true";
    expect(/caddy reload[^\n]*\|\|\s*true/.test(split)).toBe(false);
    expect(/caddy reload[^\n]*\|\|\s*true/.test(joinContinuations(split))).toBe(
      true,
    );
  });

  it("catches the split form end-to-end, not just in the helper", () => {
    const repo = healthy();
    repo.bootstrap = repo.bootstrap.replace(
      "    if docker exec oxagen-caddy caddy reload --config /etc/caddy/Caddyfile; then",
      "    docker exec oxagen-caddy caddy reload \\\n      --config /etc/caddy/Caddyfile || true",
    );
    expect(inspect(repo).join("\n")).toContain("|| true");
  });
});

describe("withoutComments", () => {
  it("keeps the check from failing on its own subject's documentation", () => {
    // Both scripts explain these defects by quoting the code they replaced. A
    // scanner that read comments would flag the explanation, and the fix for
    // that would be to delete it.
    const quoted = "# it used to be: caddy reload ... || true";
    expect(withoutComments(`${quoted}\ncaddy reload`)).toBe("caddy reload");
    expect(inspect(healthy())).toEqual([]);
  });
});

describe("remoteTemplate and lineIndexOf", () => {
  it("finds the heredoc even with a trailing `|| true` on its opener", () => {
    // `read -r -d '' VAR <<'REMOTE_EOF' || true` is the real form; a regex
    // anchored to a newline right after the delimiter finds nothing, and every
    // assertion about the remote script then passes vacuously.
    const installer =
      "read -r -d '' T <<'REMOTE_EOF' || true\nbody\nREMOTE_EOF";
    expect(remoteTemplate(installer)).toBe("body");
    expect(remoteTemplate("no heredoc here")).toBeNull();
  });

  it("returns -1 rather than 0 when nothing matches", () => {
    // 0 is a valid index, so a bug here would read as "it happens first" and
    // silently satisfy an ordering assertion.
    expect(lineIndexOf("a\nb", /zzz/)).toBe(-1);
    expect(lineIndexOf("a\nb", /b/)).toBe(1);
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

  it("reads the real installer and the real bootstrap, not a stale path", () => {
    // If either constant pointed at a file that no longer exists, run() would
    // throw rather than pass — but if one pointed at the WRONG file, every
    // ordering assertion above would pass vacuously against the real repo.
    expect(BOOTSTRAP).toBe("infra/modules/app-node/user-data.sh.tftpl");
    expect(CANONICAL_KEY).toBe("_caddy/Caddyfile");
    expect(run()).toEqual([]);
  });
});

/**
 * The retry chain, EXECUTED rather than read.
 *
 * Everything above this point is a text assertion, and text assertions cannot
 * decide this one: the defect needs two runs. Run one's `caddy reload` fails
 * and the candidate is left on disk; run two's `cmp -s` compares the same
 * render against that file, finds it identical, prints "caddy config
 * unchanged", skips the reload and exits 0 — at which point the caller promotes
 * the candidate to the canonical key and reports success, with Caddy still
 * running the old config. An operator reading that success enables
 * TRUST_EDGE_CLIENT_IP_HEADER over a Caddy that forwards a caller-supplied
 * x-oxagen-client-ip, and the IAM `ip_ranges` bypass is open again.
 *
 * So the assertion that matters is about run TWO. A test that only checked "the
 * restore happened" would pass against a version that restores the file and
 * then still reports unchanged, which is the version that ships the bypass.
 *
 * The block is executed with /opt and /tmp rewritten into a temp root and with
 * `aws` and `docker` stubbed on PATH. Control flow is what is under test; the
 * paths are not.
 */
describe("the remote Caddy block, executed", () => {
  const RENDER = "# rendered candidate\n:80 {\n}\n";
  const RUNNING = "# the config caddy is running\n:80 {\n}\n";

  function runBlock({
    root,
    reloadFails,
  }: {
    root: string;
    reloadFails: boolean;
  }): { code: number; stdout: string; stderr: string } {
    const block = caddyInstallBlock(
      readFileSync(join(repoRoot, INSTALLER), "utf8"),
    );
    expect(block).not.toBeNull();

    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    // `aws s3 cp <key> <dest>` — the only aws call in this block. It writes the
    // render, standing in for the candidate object download.
    writeFileSync(
      join(bin, "aws"),
      `#!/bin/sh\ncp "${join(root, "render")}" "$4"\n`,
      { mode: 0o755 },
    );
    // `docker run ... caddy validate` always succeeds — the render is valid,
    // which is the case that matters. `docker exec ... caddy reload` is the
    // one the test drives.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\ncase "$1" in\n  run) exit 0 ;;\n  exec) exit ${reloadFails ? "1" : "0"} ;;\nesac\nexit 0\n`,
      { mode: 0o755 },
    );

    const script =
      "set -euo pipefail\n" +
      block!
        .replaceAll("/opt/oxagen", join(root, "opt/oxagen"))
        .replaceAll("/tmp/Caddyfile", join(root, "tmp/Caddyfile"))
        .replaceAll("__BUCKET__", "bucket")
        .replaceAll("__REGION__", "us-east-1")
        .replaceAll("__CANDIDATE_KEY__", "candidate");

    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function makeRoot(withRunningConfig: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "caddy-block-"));
    mkdirSync(join(root, "opt/oxagen/caddy"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    writeFileSync(join(root, "render"), RENDER);
    if (withRunningConfig) {
      writeFileSync(join(root, "opt/oxagen/caddy/Caddyfile"), RUNNING);
    }
    return root;
  }

  it("retries the reload after a failed one, instead of reporting unchanged", () => {
    const root = makeRoot(true);
    const configPath = join(root, "opt/oxagen/caddy/Caddyfile");

    // Run 1: the reload fails transiently.
    const first = runBlock({ root, reloadFails: true });
    expect(first.code).not.toBe(0);
    // The file on disk must still be what Caddy is running. This is the
    // property the restore establishes, and on its own it is NOT the fix.
    expect(readFileSync(configPath, "utf8")).toBe(RUNNING);

    // Run 2: same render, reload now succeeds. THIS is the assertion that
    // matters — it must take the reload branch, not the "unchanged" one.
    const second = runBlock({ root, reloadFails: false });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("caddy reloaded");
    expect(second.stdout).not.toContain("caddy config unchanged");
    expect(readFileSync(configPath, "utf8")).toBe(RENDER);
  });

  it("removes the candidate when a FIRST install's reload fails", () => {
    // No accepted config exists on a brand-new node, so there is nothing to
    // restore. Leaving the candidate would make the next run's `cmp` report it
    // unchanged — the same defect, reached where the restore cannot help.
    const root = makeRoot(false);
    const configPath = join(root, "opt/oxagen/caddy/Caddyfile");

    const first = runBlock({ root, reloadFails: true });
    expect(first.code).not.toBe(0);
    expect(existsSync(configPath)).toBe(false);

    const second = runBlock({ root, reloadFails: false });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("caddy reloaded");
    expect(second.stdout).not.toContain("caddy config unchanged");
  });

  it("reports unchanged only when the config was genuinely accepted", () => {
    // The other half of the contract. Without this, a fix that simply never
    // took the unchanged branch would pass both cases above while reloading
    // Caddy on every install for no reason.
    const root = makeRoot(true);
    const first = runBlock({ root, reloadFails: false });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("caddy reloaded");

    const second = runBlock({ root, reloadFails: false });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("caddy config unchanged");
    expect(second.stdout).not.toContain("caddy reloaded");
  });
});
