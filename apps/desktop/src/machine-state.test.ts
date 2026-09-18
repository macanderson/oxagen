/**
 * What the app concludes about the machine from the files it reads: whether
 * it is enrolled, what an uninstall or a link did, whether the binaries the
 * hooks name have fallen behind the app, and a poller that never applies a
 * stale answer.
 */
import { describe, expect, it } from "vitest";
import {
  binSkew,
  createPoller,
  describeInstallResult,
  describeRemoval,
  isEnrolled,
  isRetired,
} from "./machine-state";

describe("enrolled means hooks and a service, not a host.json", () => {
  it("a host an offline unenroll retired is not enrolled", () => {
    expect(isEnrolled(null)).toBe(false);
    expect(isEnrolled({ revoked_at: null })).toBe(true);
    // Older tacho wrote no revoked_at at all.
    expect(isEnrolled({})).toBe(true);
    expect(isEnrolled({ revoked_at: "2026-09-18T00:00:00Z" })).toBe(false);
    expect(isRetired({ revoked_at: "2026-09-18T00:00:00Z" })).toBe(true);
    expect(isRetired({ revoked_at: null })).toBe(false);
    expect(isRetired(null)).toBe(false);
  });
});

describe("what an uninstall reports", () => {
  it("says what is gone, and never says everything is when something is left", () => {
    expect(
      describeRemoval(
        { removed: ["/h/.local/bin/tacho", "/h/.config/oxagen"], left: [] },
        "Drag it to the Trash.",
      ),
    ).toBe("Removed 2 items from this machine. Drag it to the Trash.");
    const partial = describeRemoval(
      {
        removed: ["/h/.config/oxagen"],
        left: [
          "oxagen: /h/.local/bin/oxagen was not created by Oxagen, left alone",
        ],
      },
      "Drag it to the Trash.",
    );
    expect(partial).toContain("Removed 1 item");
    expect(partial).toContain(
      "Still on this machine: oxagen: /h/.local/bin/oxagen",
    );
    expect(partial).not.toContain("everything");
    expect(describeRemoval({ removed: [], left: [] }, "Hint.")).toBe(
      "Nothing of Oxagen's was left on this machine. Hint.",
    );
  });
});

describe("what Link into PATH reports", () => {
  const base = {
    dir: "/h/.local/bin",
    files: [],
    skipped: [],
    on_path: true,
    note: "note.",
    profile: null,
  };
  it("tells already linked from left alone", () => {
    expect(
      describeInstallResult({
        ...base,
        state: "linked",
        files: ["/h/.local/bin/tacho"],
      }),
    ).toBe("Linked 1 tool into /h/.local/bin. note.");
    expect(describeInstallResult({ ...base, state: "already" })).toBe("note.");
    const skipped = describeInstallResult({
      ...base,
      state: "skipped",
      skipped: [
        "oxagen already on PATH at /opt/homebrew/bin/oxagen; left in place",
      ],
    });
    expect(skipped).toContain("Nothing was linked");
    expect(skipped).toContain("/opt/homebrew/bin/oxagen");
  });
});

describe("the binaries the hooks name against the app", () => {
  it("reports an older wrapper and a hook that names another directory", () => {
    expect(
      binSkew(
        {
          wrapper_version: "2.1.1",
          hook_command: "'/Applications/Oxagen.app/Contents/MacOS/tacho' hook",
        },
        {
          app_version: "2.1.1",
          bin_dir: "/Applications/Oxagen.app/Contents/MacOS",
        },
      ),
    ).toBeNull();
    expect(
      binSkew(
        {
          wrapper_version: "2.1.0",
          hook_command: "/Applications/Oxagen.app/Contents/MacOS/tacho hook",
        },
        {
          app_version: "2.1.1",
          bin_dir: "/Applications/Oxagen.app/Contents/MacOS",
        },
      ),
    ).toContain("2.1.0");
    expect(
      binSkew(
        {
          wrapper_version: "2.1.1",
          hook_command:
            "'/Users/d/Library/Application Support/oxagen/bin/tacho' hook",
        },
        {
          app_version: "2.1.1",
          bin_dir: "/Applications/Oxagen.app/Contents/MacOS",
        },
      ),
    ).toContain("Application Support/oxagen/bin");
    // A Homebrew tacho enrolled the machine: not the app's to call stale.
    expect(
      binSkew(
        {
          wrapper_version: "2.1.1",
          hook_command: "/opt/homebrew/bin/tacho hook",
        },
        { app_version: "2.1.1", bin_dir: null },
      ),
    ).toBeNull();
  });
});

describe("the poller", () => {
  it("never runs two reads at once and drops an answer that a newer one overtook", async () => {
    const applied: number[] = [];
    const gates: Array<(value: number) => void> = [];
    const poller = createPoller(
      () => new Promise<number>((resolve) => gates.push(resolve)),
      (value) => applied.push(value),
    );
    const first = poller.poll();
    // A tick that lands while the first read is out does not start another.
    const second = poller.poll();
    expect(gates).toHaveLength(1);
    gates[0]?.(1);
    await Promise.all([first, second]);
    expect(applied).toEqual([1]);
    // A forced read (after an action) starts at once and wins.
    const slow = poller.poll();
    const forced = poller.poll({ force: true });
    expect(gates).toHaveLength(3);
    gates[2]?.(3);
    await forced;
    gates[1]?.(2);
    await slow;
    expect(applied).toEqual([1, 3]);
  });

  it("hands a failed read to onError and keeps polling", async () => {
    const errors: string[] = [];
    let fail = true;
    const applied: number[] = [];
    const poller = createPoller(
      async () => {
        if (fail) throw new Error("boom");
        return 7;
      },
      (value) => applied.push(value),
      (error) => errors.push(String(error)),
    );
    await poller.poll();
    fail = false;
    await poller.poll();
    expect(errors).toEqual(["Error: boom"]);
    expect(applied).toEqual([7]);
  });
});
