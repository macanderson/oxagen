import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { startDaemon } from "./daemon";
import { createCollectorServer } from "./server";

const idleServer = () => createCollectorServer(() => undefined);

describe("collector startup ownership", () => {
  it("refuses an occupied TCP port before changing the WAL or the live Unix listener", async () => {
    const paths = scratchPaths();
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.daemonState, "existing registry");
    const active = idleServer();
    const listening = await active.listen({
      port: 0,
      socketPath: paths.socket,
    });
    const signer = bundleSigner();
    const host = testHostFile(signer, signer.sign(unsignedBundle()));
    try {
      await expect(
        startDaemon({ paths, host, port: listening.port }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(readFileSync(paths.daemonState, "utf8")).toBe("existing registry");
      expect(existsSync(paths.wal)).toBe(false);
      expect(existsSync(paths.deviceKey)).toBe(false);
      expect(existsSync(paths.socket)).toBe(true);
      const competitor = idleServer();
      try {
        await expect(
          competitor.listen({ port: 0, socketPath: paths.socket }),
        ).rejects.toThrow("another collector is listening");
      } finally {
        await competitor.close();
      }
    } finally {
      await active.close();
    }
  });

  it("releases a TCP listener when its Unix bind fails", async () => {
    const paths = scratchPaths();
    mkdirSync(paths.root, { recursive: true });
    const reservation = idleServer();
    const { port } = await reservation.listen({ port: 0 });
    await reservation.close();
    const failed = idleServer();
    const replacement = idleServer();
    try {
      // The errno for "the parent directory is not there" is not the same on
      // every platform. Binding a Unix socket under a missing directory gives
      // ENOENT on macOS and EACCES on Linux, so pinning one of them asserts
      // the author's machine rather than the behaviour: #3599 pinned ENOENT,
      // passed locally, and reddened main on the Linux runner.
      //
      // What this test is named for is the release, so the bind has to fail
      // for a reason that is about the path, and the next assertion is the
      // subject. Accepting either code still refuses EADDRINUSE, which is the
      // failure that would mean the TCP reservation leaked instead.
      await expect(
        failed.listen({
          port,
          socketPath: join(paths.root, "missing", "daemon.sock"),
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:ENOENT|EACCES)$/),
      });
      await expect(replacement.listen({ port })).resolves.toEqual({ port });
    } finally {
      await failed.close();
      await replacement.close();
    }
  });

  it("preserves a regular file at the requested socket path", async () => {
    const paths = scratchPaths();
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.socket, "keep this file");
    const server = idleServer();
    try {
      await expect(
        server.listen({ port: 0, socketPath: paths.socket }),
      ).rejects.toThrow("not a socket");
      expect(readFileSync(paths.socket, "utf8")).toBe("keep this file");
    } finally {
      await server.close();
    }
  });
});
