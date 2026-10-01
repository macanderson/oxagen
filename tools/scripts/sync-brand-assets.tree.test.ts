// This test reads the desktop icons and the synced avatar in the live tree.
// vitest.config.ts leaves `*.tree.test.ts` files out of turbo's cached tasks,
// so `pnpm check:tree-guards` runs them uncached in the checks job (#4664
// item 2). The cached tests in sync-brand-assets.test.ts run the sync against
// a fake kit instead.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { desktopIconDrift } from "./sync-brand-assets.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ICONS = "apps/desktop/src-tauri/icons";
const AVATAR = "apps/app/public/brand/oxagen-avatar-light.svg";

describe("the desktop icon stamp", () => {
  // #4892: a kit icon change must keep CI red until the desktop icons follow.
  it("is committed for the icons in this tree, cut from the synced avatar", () => {
    const committed = new Map(
      readdirSync(join(REPO_ROOT, ICONS))
        .filter((name) => name !== "source.sha256")
        .map((name): [string, Buffer] => [
          `${ICONS}/${name}`,
          readFileSync(join(REPO_ROOT, ICONS, name)),
        ]),
    );
    const stamp = readFileSync(join(REPO_ROOT, ICONS, "source.sha256"), "utf8");
    const synced = new Map([[AVATAR, readFileSync(join(REPO_ROOT, AVATAR))]]);
    expect(desktopIconDrift(stamp, synced, committed)).toBeNull();
  });
});
