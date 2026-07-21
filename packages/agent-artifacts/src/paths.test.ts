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
});
