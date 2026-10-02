/**
 * `oxagen agent uninstall` (ADR-230 amendment, #4298): the desktop app has
 * gone to the Trash, and the command takes Oxagen off the machine from the
 * journal the app kept. The rig enrolls every harness against a scratch HOME
 * that looks like a real machine, lays down what the app writes at launch
 * (its per-user copy, a PATH link, the profile block, and `desktop.json`
 * with its journal), deletes the app, and runs the command.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TachoHarness } from "../wire";
import { runtimeCommands } from "./deps";
import { enroll } from "./enroll";
import {
  buildRig,
  diffTrees,
  type Rig,
  seedHome,
  snapshotTree,
} from "./install-rig";
import {
  type JournalEntry,
  dataLocalDir,
  readDesktopRecord,
  removePathBlocks,
  uninstall,
} from "./uninstall";

const BLOCK = (dir: string, eol = "\n") =>
  `# >>> oxagen >>>${eol}export PATH="$PATH:${dir}"${eol}# <<< oxagen <<<${eol}`;

describe("taking the app's PATH lines out of a profile", () => {
  it("gives back the file the app found, byte for byte", () => {
    const mine = 'export EDITOR=vim\nexport PATH="$HOME/bin:$PATH"\n';
    // The app puts one line break between the file and its block.
    expect(removePathBlocks(`${mine}\n${BLOCK("/home/u/.local/bin")}`)).toBe(
      mine,
    );
    // A profile the app created holds the block alone.
    expect(removePathBlocks(BLOCK("/home/u/.local/bin"))).toBe("");
    // A file without a final line break.
    expect(removePathBlocks(`x=1\n${BLOCK("/b")}`)).toBe("x=1");
  });

  it("keeps the file's own CRLF line breaks", () => {
    const mine = "set -o vi\r\n";
    expect(removePathBlocks(`${mine}\r\n${BLOCK("/b", "\r\n")}`)).toBe(mine);
  });

  it("removes the prepending block an earlier app version wrote, and every block", () => {
    const old =
      '# >>> oxagen >>>\nexport PATH="/home/u/.local/bin:$PATH"\n# <<< oxagen <<<\n';
    expect(
      removePathBlocks(`a\n\n${old}b\n\n${BLOCK("/home/u/.local/bin")}`),
    ).toBe("a\nb\n");
  });

  it("leaves a block the person changed, and an orphan marker (negative)", () => {
    const edited =
      'a\n\n# >>> oxagen >>>\nexport PATH="$PATH:/b"\nexport FOO=1\n# <<< oxagen <<<\n';
    expect(removePathBlocks(edited)).toBe(edited);
    const orphan = 'a\n# >>> oxagen >>>\nexport PATH="$PATH:/b"\n';
    expect(removePathBlocks(orphan)).toBe(orphan);
    const plain = "no block here\n";
    expect(removePathBlocks(plain)).toBe(plain);
  });
});

describe("reading the app's journal", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "oxagen-journal-"));

  it("reads nothing from a file that is not there", () => {
    const record = readDesktopRecord(join(scratch(), "desktop.json"));
    expect(record).toMatchObject({ found: false, journaled: false, journal: [] });
    expect(record.problem).toBeUndefined();
  });

  it("names a file it cannot read, and acts on none of it (negative)", () => {
    const path = join(scratch(), "desktop.json");
    writeFileSync(path, "{not json");
    const record = readDesktopRecord(path);
    expect(record.found).toBe(false);
    expect(record.problem).toContain(path);
  });

  it("drops an entry that is not one the app writes (negative)", () => {
    const path = join(scratch(), "desktop.json");
    writeFileSync(
      path,
      JSON.stringify({
        created: ["/home/u/.local/bin", "relative/dir", 7],
        configDirCreated: true,
        journal: [
          { kind: "link", path: "/home/u/.local/bin/tacho", target: "/c/tacho" },
          { kind: "link", path: "/home/u/.local/bin/oxagen" },
          { kind: "shim", path: "C:/x/oxagen.cmd" },
          { kind: "copy", path: "relative/2.1.3" },
          { kind: "rm-rf", path: "/" },
          { kind: "profile", path: "/home/u/.zprofile" },
        ],
      }),
    );
    const record = readDesktopRecord(path);
    expect(record.journaled).toBe(true);
    expect(record.configDirCreated).toBe(true);
    expect(record.created).toEqual(["/home/u/.local/bin"]);
    expect(record.journal).toEqual<JournalEntry[]>([
      { kind: "link", path: "/home/u/.local/bin/tacho", target: "/c/tacho" },
      { kind: "profile", path: "/home/u/.zprofile" },
    ]);
  });

  it("finds the app's directory where the app does", () => {
    expect(dataLocalDir("/Users/u", {}, "darwin")).toBe(
      "/Users/u/Library/Application Support",
    );
    expect(dataLocalDir("/home/u", {}, "linux")).toBe("/home/u/.local/share");
    expect(dataLocalDir("/home/u", { XDG_DATA_HOME: "/data" }, "linux")).toBe(
      "/data",
    );
    // A relative XDG_DATA_HOME is ignored, as the XDG spec says.
    expect(dataLocalDir("/home/u", { XDG_DATA_HOME: "data" }, "linux")).toBe(
      "/home/u/.local/share",
    );
  });
});

const ALL: TachoHarness[] = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-desktop",
];

/** A stand-in for one of the app's two sidecars. */
function stub(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\ncat >/dev/null\n");
  chmodSync(path, 0o755);
}

interface DesktopInstall {
  app: string;
  copy: string;
  link: string;
  profile: string;
  desktopJson: string;
}

/**
 * What the desktop app's launch writes on a Mac, the way
 * `cli_install.rs` writes it: both sidecars copied into the versioned
 * per-user directory, `tacho` linked into `~/.local/bin` (the person's own
 * `oxagen` there is left alone), the PATH block appended to `.zprofile`,
 * and `desktop.json` with the directories it made and its journal.
 */
function installDesktopApp(home: string, journaled = true): DesktopInstall {
  const app = join(home, "Applications", "Oxagen.app");
  stub(join(app, "Contents", "MacOS", "oxagen"));
  stub(join(app, "Contents", "MacOS", "tacho"));
  const support = join(home, "Library", "Application Support");
  const copy = join(support, "oxagen", "bin", "2.1.3");
  stub(join(copy, "oxagen"));
  stub(join(copy, "tacho"));
  const linkDir = join(home, ".local", "bin");
  const link = join(linkDir, "tacho");
  symlinkSync(join(copy, "tacho"), link);
  const profile = join(home, ".zprofile");
  writeFileSync(
    profile,
    `${readFileSync(profile, "utf8")}\n${BLOCK(linkDir)}`,
  );
  const journal = [
    { kind: "copy", path: copy },
    { kind: "link", path: link, target: join(copy, "tacho") },
    { kind: "profile", path: profile },
  ];
  const desktopJson = join(home, ".config", "oxagen", "desktop.json");
  mkdirSync(dirname(desktopJson), { recursive: true });
  writeFileSync(
    desktopJson,
    `${JSON.stringify(
      {
        autoLinkCli: true,
        created: [
          join(support, "oxagen"),
          join(support, "oxagen", "bin"),
          copy,
        ],
        ...(journaled ? { journal } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return { app, copy, link, profile, desktopJson };
}

/** Enroll every harness the way the app's sidecar does: hooks name the copy. */
async function enrollFromTheApp(
  seed: ReturnType<typeof seedHome>,
  install: DesktopInstall,
): Promise<Rig> {
  const runtime = runtimeCommands(
    undefined,
    { TACHO_BIN_DIR: install.copy },
    join(install.app, "Contents", "MacOS", "tacho"),
    "darwin",
    true,
  );
  const rig = buildRig(seed, { overrides: { runtime } });
  const enrolled = await enroll({ harnesses: ALL }, rig.deps);
  expect(enrolled.ok, enrolled.warnings.join("\n")).toBe(true);
  return rig;
}

describe.skipIf(process.platform === "win32")(
  "uninstalling with the desktop app already in the Trash",
  () => {
    it("takes off everything the app and enrollment wrote, and nothing else", async () => {
      const seed = seedHome();
      const before = snapshotTree(seed.home);
      const install = installDesktopApp(seed.home);
      const rig = await enrollFromTheApp(seed, install);
      // The app goes to the Trash. Its copy, link, and block stay.
      rmSync(join(seed.home, "Applications"), { recursive: true, force: true });

      const result = await uninstall({}, rig.deps);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.left).toEqual([]);
      expect(rig.serviceLoaded()).toBe(false);
      // `~/.config/oxagen` goes, as the app's own Uninstall removes it: the
      // CLI login in it with the rest. Every other byte is as it was.
      const diff = diffTrees(before, snapshotTree(seed.home));
      expect(diff.added).toEqual([]);
      expect(diff.changed).toEqual([]);
      expect(diff.removed.sort()).toEqual([
        ".config/oxagen",
        ".config/oxagen/config.json",
      ]);
      // The person's own `oxagen` in the link directory is theirs.
      expect(
        readFileSync(join(seed.home, ".local", "bin", "oxagen"), "utf8"),
      ).toContain("my own oxagen");

      // Run again: nothing left to do, nothing fails, and the tree is the
      // same.
      const again = await uninstall({}, rig.deps);
      expect(again.ok, JSON.stringify(again)).toBe(true);
      expect(again.left).toEqual([]);
      expect(diffTrees(before, snapshotTree(seed.home))).toEqual(diff);
    });

    it("stops after the unenroll while a hook still names the copy (negative)", async () => {
      const seed = seedHome();
      const install = installDesktopApp(seed.home);
      const rig = await enrollFromTheApp(seed, install);
      rmSync(install.app, { recursive: true, force: true });
      // A harness file the person has since broken: unenroll cannot take
      // the hook out of it, so the hook still runs the copy.
      writeFileSync(rig.deps.paths.codexHooks, "{ not json");

      const result = await uninstall({}, rig.deps);
      expect(result.ok).toBe(false);
      expect(result.removed).toEqual([]);
      expect(rig.errors.join("\n")).toContain("oxagen agent uninstall");
      // The copy the hook runs, the link, the block, and the journal stay.
      expect(existsSync(join(install.copy, "tacho"))).toBe(true);
      expect(readlinkSync(install.link)).toBe(join(install.copy, "tacho"));
      expect(readFileSync(install.profile, "utf8")).toContain(
        "# >>> oxagen >>>",
      );
      expect(existsSync(install.desktopJson)).toBe(true);
    });

    it("leaves a link someone pointed elsewhere, and says so (negative)", async () => {
      const seed = seedHome();
      const install = installDesktopApp(seed.home);
      const rig = await enrollFromTheApp(seed, install);
      rmSync(install.app, { recursive: true, force: true });
      const theirs = join(seed.home, "bin", "tacho");
      stub(theirs);
      rmSync(install.link);
      symlinkSync(theirs, install.link);

      const result = await uninstall({}, rig.deps);
      expect(result.ok).toBe(false);
      expect(readlinkSync(install.link)).toBe(theirs);
      expect(result.left.join("\n")).toContain(install.link);
      // Everything else still went.
      expect(existsSync(install.copy)).toBe(false);
      expect(readFileSync(install.profile, "utf8")).not.toContain(
        "# >>> oxagen >>>",
      );
    });

    it("removes the copies without a journal, and names the links to delete by hand", async () => {
      const seed = seedHome();
      // An app from before the journal: `desktop.json` lists what it
      // created and nothing it wrote.
      const install = installDesktopApp(seed.home, false);
      const rig = await enrollFromTheApp(seed, install);
      rmSync(install.app, { recursive: true, force: true });

      const result = await uninstall({}, rig.deps);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(existsSync(install.copy)).toBe(false);
      expect(result.warnings.join("\n")).toContain("No record");
      // Nothing recorded it, so nothing removed it.
      expect(readlinkSync(install.link)).toBe(join(install.copy, "tacho"));
    });
  },
);
