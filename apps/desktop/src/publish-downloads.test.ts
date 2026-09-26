/**
 * `scripts/publish-downloads.mjs` run end to end against fake `aws`, `gh`
 * and `curl` on PATH, with `TMPDIR` pointed at a scratch directory so every
 * temp directory it makes can be counted afterwards (#3330).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { artifactDownloadCurl } from "./downloads";

const SCRIPT = fileURLToPath(
  new URL("../scripts/publish-downloads.mjs", import.meta.url),
);
const V = "2.1.1";
const TOKEN = "gho_sentinel0123456789";

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A scratch root with `bin/` for the fakes and `tmp/` as `TMPDIR`. */
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "publish-test-")));
  scratches.push(root);
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  mkdirSync(bin);
  mkdirSync(tmp);
  const fake = (name: string, body: string) =>
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\n${body}\n`,
      { mode: 0o755 },
    );
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: tmp,
        ...env,
      },
    });
  return { root, tmp, fake, run };
}

describe("artifactDownloadCurl", () => {
  it("puts the token in the config and never in the arguments", () => {
    const { args, config } = artifactDownloadCurl({
      token: TOKEN,
      url: "https://api.github.com/repos/o/r/actions/artifacts/7/zip",
      out: "/tmp/a.zip",
    });
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.slice(0, 2)).toEqual(["--config", "-"]);
    expect(args.at(-1)).toBe(
      "https://api.github.com/repos/o/r/actions/artifacts/7/zip",
    );
    expect(config).toBe(`header = "Authorization: Bearer ${TOKEN}"\n`);
  });

  it("escapes a quote or a backslash and refuses a line break", () => {
    const { config } = artifactDownloadCurl({
      token: 'a"b\\c',
      url: "u",
      out: "o",
    });
    expect(config).toBe('header = "Authorization: Bearer a\\"b\\\\c"\n');
    for (const token of ["a\nb", "a\rb", "a\0b"])
      expect(() => artifactDownloadCurl({ token, url: "u", out: "o" })).toThrow(
        "line break",
      );
  });
});

describe("publish-downloads.mjs", () => {
  it("hands curl the token on stdin and removes its temp directory when curl fails", () => {
    const { root, tmp, fake, run } = scratch();
    const record = join(root, "curl.json");
    fake(
      "aws",
      `if (args[0] === "s3api" && args[1] === "list-objects-v2") { console.log('{"KeyCount": 0}'); process.exit(0); }
process.exit(1);`,
    );
    fake(
      "gh",
      `if (args[0] === "auth") { console.log(${JSON.stringify(TOKEN)}); process.exit(0); }
console.log(JSON.stringify({ artifacts: [{ name: "oxagen-desktop-macos", id: 7, size_in_bytes: 1000000 }] }));`,
    );
    fake(
      "curl",
      `fs.writeFileSync(process.env.CURL_RECORD, JSON.stringify({ args, stdin: fs.readFileSync(0, "utf8") }));
process.exit(22);`,
    );
    const result = run(["--run", "99", "--version", V], {
      CURL_RECORD: record,
    });
    expect(result.status, result.stderr).toBe(22);
    const curl = JSON.parse(readFileSync(record, "utf8")) as {
      args: string[];
      stdin: string;
    };
    expect(curl.args.join(" ")).not.toContain(TOKEN);
    expect(curl.stdin).toContain(`Authorization: Bearer ${TOKEN}`);
    // The failure message names the command and its arguments, not the token.
    expect(result.stderr).toContain("curl --config -");
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.stdout).not.toContain(TOKEN);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("removes both temp directories when a resumed publish stops at latest.json", () => {
    const { root, tmp, fake, run } = scratch();
    const source = join(root, "installers");
    mkdirSync(source);
    const file = `Oxagen_${V}_aarch64.dmg`;
    writeFileSync(join(source, file), "installer bytes");
    const digest = createHash("sha256").update("installer bytes").digest("hex");
    fake(
      "aws",
      `const prefix = "desktop/${V}/";
if (args[0] === "s3api" && args[1] === "list-objects-v2") {
  console.log(JSON.stringify({ KeyCount: 2, Contents: [
    { Key: prefix + "SHA256SUMS.txt", Size: 80, LastModified: "2026-09-19" },
    { Key: prefix + ${JSON.stringify(file)}, Size: 15, LastModified: "2026-09-19" },
  ] }));
  process.exit(0);
}
if (args[0] === "s3" && args[1] === "cp" && args[2].endsWith("/SHA256SUMS.txt")) {
  process.stdout.write(${JSON.stringify(`${digest}  ${file}\n`)});
  process.exit(0);
}
if (args[0] === "s3" && args[1] === "cp" && args[2].endsWith("/latest.json")) {
  console.error("An error occurred (AccessDenied) when calling the GetObject operation");
  process.exit(1);
}
process.exit(1);`,
    );
    const result = run(["--dir", source, "--version", V, "--resume"]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("could not read");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("removes its temp directory when the build holds no installer", () => {
    const { root, tmp, fake, run } = scratch();
    const empty = join(root, "empty");
    mkdirSync(empty);
    fake(
      "aws",
      `if (args[0] === "s3api" && args[1] === "list-objects-v2") { console.log('{"KeyCount": 0}'); process.exit(0); }
process.exit(1);`,
    );
    const result = run(["--dir", empty, "--version", V]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("no installers");
    expect(readdirSync(tmp)).toEqual([]);
  });
});
