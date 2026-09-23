import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { validateContainedWorkspace } from "./workspace";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "contained-tree-")));
  roots.push(root);
  const workspace = join(root, "repo");
  const session = join(root, "session");
  mkdirSync(workspace);
  mkdirSync(session);
  writeFileSync(join(workspace, "README.md"), "Example repository");
  return { root, workspace, session };
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe("contained workspace inspection", () => {
  it("accepts a plain checkout and internal symbolic links", () => {
    const { workspace, session } = fixture();
    symlinkSync("README.md", join(workspace, "readme-link"));
    expect(() =>
      validateContainedWorkspace(workspace, session, ""),
    ).not.toThrow();
  });
  it.each([".env.example", ".env.sample", ".env.template"])(
    "accepts the committed template %s",
    (name) => {
      const { workspace, session } = fixture();
      writeFileSync(join(workspace, name), "DATABASE_URL=");
      expect(() =>
        validateContainedWorkspace(workspace, session, ""),
      ).not.toThrow();
    },
  );
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.example.local",
    ".aws",
    ".ssh",
    ".netrc",
    ".git-credentials",
  ])("refuses local credential path %s", (name) => {
    const { workspace, session } = fixture();
    writeFileSync(join(workspace, name), "secret");
    expect(() => validateContainedWorkspace(workspace, session, "")).toThrow(
      "credential files",
    );
  });
  it("refuses configuration inside the writable checkout", () => {
    const { workspace } = fixture();
    const session = join(workspace, "session");
    mkdirSync(session);
    expect(() => validateContainedWorkspace(workspace, session, "")).toThrow(
      "separate directories",
    );
  });
  it("refuses external links and hard-linked files", () => {
    const { root, workspace, session } = fixture();
    writeFileSync(join(root, "external"), "private");
    symlinkSync(join(root, "external"), join(workspace, "linked"));
    expect(() => validateContainedWorkspace(workspace, session, "")).toThrow(
      "outside the checkout",
    );
    rmSync(join(workspace, "linked"));
    linkSync(join(root, "external"), join(workspace, "linked"));
    expect(() => validateContainedWorkspace(workspace, session, "")).toThrow(
      "hard-linked",
    );
  });
  it("refuses nested mounts and Unix sockets", async () => {
    const { workspace, session } = fixture();
    expect(() =>
      validateContainedWorkspace(
        workspace,
        session,
        `1 0 0:1 / ${workspace}/nested rw - tmpfs tmpfs rw`,
      ),
    ).toThrow("nested mount");
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(join(workspace, "service.sock"), resolve),
    );
    try {
      expect(() => validateContainedWorkspace(workspace, session, "")).toThrow(
        "socket",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
