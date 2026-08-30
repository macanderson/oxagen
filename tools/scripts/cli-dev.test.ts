import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  BIN_NAME,
  LAUNCHER_MARKER,
  buildLauncherScript,
  classifyBin,
  firstBinOnPath,
  hasGlobalPkg,
  isOurLauncher,
  parsePathEntries,
  pickInstallDir,
  uniqueDirs,
} from "./lib/cli-dev";

describe("BIN_NAME", () => {
  it("is the `oxagen` command name", () => {
    expect(BIN_NAME).toBe("oxagen");
  });
});

describe("parsePathEntries", () => {
  it("splits on the path delimiter, resolving and de-duplicating", () => {
    expect(parsePathEntries("/a:/b:/a")).toEqual(["/a", "/b"]);
  });

  it("drops empty segments and normalises redundant separators", () => {
    expect(parsePathEntries("/a//b:")).toEqual([join("/a", "b")]);
  });

  it("returns [] for undefined or empty PATH", () => {
    expect(parsePathEntries(undefined)).toEqual([]);
    expect(parsePathEntries("")).toEqual([]);
  });
});

describe("uniqueDirs", () => {
  it("drops nullish entries and de-duplicates while preserving order", () => {
    expect(uniqueDirs(["/a", null, "/b", undefined, "/a"])).toEqual([
      "/a",
      "/b",
    ]);
  });
});

describe("buildLauncherScript", () => {
  const script = buildLauncherScript(
    "/repo/node_modules/.bin/tsx",
    "/repo/apps/cli/src/index.tsx",
  );

  it("is a /bin/sh script that execs tsx against the source entry, passing args through", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('__OXAGEN_TSX="/repo/node_modules/.bin/tsx"');
    expect(script).toContain('__OXAGEN_ENTRY="/repo/apps/cli/src/index.tsx"');
    expect(script).toContain('exec "$__OXAGEN_TSX" "$__OXAGEN_ENTRY" "$@"');
  });

  it("embeds the launcher marker so future runs recognise it", () => {
    expect(script).toContain(LAUNCHER_MARKER);
  });

  it("self-checks that the monorepo paths still exist before exec", () => {
    expect(script).toContain(
      'if [ ! -x "$__OXAGEN_TSX" ] || [ ! -f "$__OXAGEN_ENTRY" ]; then',
    );
    expect(script).toContain("exit 127");
  });
});

describe("isOurLauncher / classifyBin", () => {
  const srcEntry = "/repo/apps/cli/src/index.tsx";
  const ours = buildLauncherScript("/repo/node_modules/.bin/tsx", srcEntry);

  it("recognises a launcher this repo generated for this checkout", () => {
    expect(isOurLauncher(ours, srcEntry)).toBe(true);
    expect(classifyBin(ours, srcEntry)).toBe("dev-launcher");
  });

  it("treats a launcher for a DIFFERENT checkout as external", () => {
    const other = buildLauncherScript(
      "/other/node_modules/.bin/tsx",
      "/other/apps/cli/src/index.tsx",
    );
    expect(isOurLauncher(other, srcEntry)).toBe(false);
    expect(classifyBin(other, srcEntry)).toBe("external");
  });

  it("treats a published binary / unreadable file as external", () => {
    expect(
      isOurLauncher("#!/usr/bin/env node\nrequire('@oxagen/cli')", srcEntry),
    ).toBe(false);
    expect(classifyBin(null, srcEntry)).toBe("external");
  });
});

describe("firstBinOnPath", () => {
  const pathEntries = ["/first/bin", "/second/bin", "/third/bin"];

  it("returns the bin in the earliest PATH dir that has it", () => {
    const exists = (p: string) =>
      p === join("/second/bin", "oxagen") || p === join("/third/bin", "oxagen");
    expect(firstBinOnPath(pathEntries, "oxagen", exists)).toBe(
      join("/second/bin", "oxagen"),
    );
  });

  it("returns null when no PATH dir has the bin", () => {
    expect(firstBinOnPath(pathEntries, "oxagen", () => false)).toBeNull();
  });
});

describe("pickInstallDir", () => {
  const localBin = "/home/u/.local/bin";

  it("prefers ~/.local/bin when it is on PATH and writable", () => {
    const result = pickInstallDir({
      localBin,
      pathEntries: ["/usr/bin", localBin],
      isWritable: () => true,
    });
    expect(result).toEqual({ dir: localBin, onPath: true });
  });

  it("falls back to the first writable on-PATH dir when ~/.local/bin is not writable", () => {
    const result = pickInstallDir({
      localBin,
      pathEntries: ["/usr/bin", "/home/u/bin"],
      isWritable: (dir) => dir === "/home/u/bin",
    });
    expect(result).toEqual({ dir: "/home/u/bin", onPath: true });
  });

  it("falls back to ~/.local/bin with onPath=false when nothing writable is on PATH", () => {
    const result = pickInstallDir({
      localBin,
      pathEntries: ["/usr/bin"],
      isWritable: () => false,
    });
    expect(result).toEqual({ dir: localBin, onPath: false });
  });

  it("never installs into a dir that is not on PATH even if writable", () => {
    const result = pickInstallDir({
      localBin,
      pathEntries: ["/usr/bin"], // localBin not on PATH
      isWritable: () => true,
    });
    // /usr/bin is on PATH and writable, so it wins over the off-PATH localBin.
    expect(result).toEqual({ dir: "/usr/bin", onPath: true });
  });
});

describe("hasGlobalPkg", () => {
  it("detects the <root>/@oxagen/cli layout (pnpm)", () => {
    const exists = (p: string) => p === join("/pnpm/global", "@oxagen/cli");
    expect(hasGlobalPkg("/pnpm/global", exists)).toBe(true);
  });

  it("detects the <root>/node_modules/@oxagen/cli layout (npm)", () => {
    const exists = (p: string) =>
      p === join("/npm/lib/node_modules", "node_modules/@oxagen/cli");
    expect(hasGlobalPkg("/npm/lib/node_modules", exists)).toBe(true);
  });

  it("returns false for a null root or when the package is absent", () => {
    expect(hasGlobalPkg(null, () => true)).toBe(false);
    expect(hasGlobalPkg("/some/root", () => false)).toBe(false);
  });
});
