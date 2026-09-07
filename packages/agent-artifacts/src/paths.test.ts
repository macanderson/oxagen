import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveContainedPath } from "./paths";

describe("artifact reference containment", () => {
  it("resolves a contained sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-path-"));
    await mkdir(join(root, "references"));
    await writeFile(join(root, "skill.toml"), "");
    await writeFile(join(root, "references", "guide.md"), "guide");

    await expect(
      resolveContainedPath(join(root, "skill.toml"), "references/guide.md"),
    ).resolves.toBe(join(root, "references", "guide.md"));
  });

  it("rejects traversal, absolute paths, and escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-path-"));
    const outside = await mkdtemp(join(tmpdir(), "artifact-outside-"));
    await writeFile(join(root, "skill.toml"), "");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

    await expect(
      resolveContainedPath(join(root, "skill.toml"), "../secret.txt"),
    ).rejects.toThrowError(/invalid_reference_path/);
    await expect(
      resolveContainedPath(
        join(root, "skill.toml"),
        join(outside, "secret.txt"),
      ),
    ).rejects.toThrowError(/invalid_reference_path/);
    await expect(
      resolveContainedPath(join(root, "skill.toml"), "escape.txt"),
    ).rejects.toThrowError(/invalid_reference_path/);
  });
  // The write case (#1429). Containment used to be proved only for a path that
  // already existed: a target that did not resolved to ENOENT and was returned
  // on the lexical check alone, so a reference THROUGH a symlinked directory
  // was accepted and a write to it landed outside the bundle.
  it("rejects a not-yet-existing target reached through a symlinked directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-path-"));
    const outside = await mkdtemp(join(tmpdir(), "artifact-outside-"));
    await writeFile(join(root, "skill.toml"), "");
    await mkdir(join(outside, "drop"), { recursive: true });
    // `assets` is inside the bundle by name and outside it on disk.
    await symlink(join(outside, "drop"), join(root, "assets"));

    // Nothing is written at either path: this is the state a writer is in.
    await expect(
      resolveContainedPath(join(root, "skill.toml"), "assets/new-file.png"),
    ).rejects.toThrowError(/invalid_reference_path/);
    await expect(
      resolveContainedPath(
        join(root, "skill.toml"),
        "assets/deep/new-file.png",
      ),
    ).rejects.toThrowError(/invalid_reference_path/);
  });

  it("still allows a not-yet-existing target under a real directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-path-"));
    await writeFile(join(root, "skill.toml"), "");
    await mkdir(join(root, "assets"), { recursive: true });

    // The control the check above needs: without it, refusing every missing
    // path would pass that test and break every artifact that writes one.
    await expect(
      resolveContainedPath(join(root, "skill.toml"), "assets/new-file.png"),
    ).resolves.toBe(join(root, "assets", "new-file.png"));
    // Neither the file nor its directory exists yet.
    await expect(
      resolveContainedPath(join(root, "skill.toml"), "fresh/dir/new-file.png"),
    ).resolves.toBe(join(root, "fresh", "dir", "new-file.png"));
  });
});
