import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProxyListener } from "./model-proxy-listener";

// The listener's server, so a test can raise the error an accept loop raises
// when the host runs out of file descriptors.
const servers = vi.hoisted(() => [] as Server[]);
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      servers.push(server);
      return server;
    },
  };
});

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      res.on("end", () => resolve(text));
    })
      .on("error", reject)
      .end();
  });
}

describe("the model proxy listener once it is bound", () => {
  afterEach(() => {
    servers.length = 0;
  });

  it("keeps serving, and keeps the connections it has, through an accept error", async () => {
    const log: string[] = [];
    let held: ServerResponse | undefined;
    const listener = createModelProxyListener({
      proxy: {
        handle: (req: IncomingMessage, res: ServerResponse) => {
          if (req.url === "/stream") {
            held = res;
            res.writeHead(200);
            res.write("open");
            return;
          }
          res.end("ok");
        },
        handleUpgrade: () => undefined,
      } as never,
      port: 0,
      log: (line) => log.push(line),
      retryMs: 20,
      maxRetryMs: 40,
    });
    await listener.start();
    expect(listener.listening()).toBe(true);
    const port = listener.port();

    // A stream in flight when the error lands.
    const stream = new Promise<string>((resolve) => {
      request(
        { host: "127.0.0.1", port, path: "/stream", agent: false },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => {
            text += chunk.toString();
          });
          res.on("end", () => resolve(text));
          res.on("close", () => resolve(`${text}|closed`));
        },
      ).end();
    });
    await vi.waitFor(() => expect(held).toBeDefined());

    const server = servers.at(-1)!;
    const emfile = Object.assign(new Error("accept EMFILE"), {
      code: "EMFILE",
    });
    server.emit("error", emfile);
    server.emit("error", emfile);

    expect(listener.listening()).toBe(true);
    expect(listener.restarts()).toBe(0);
    expect(await get(port)).toBe("ok");
    held!.end("-done");
    expect(await stream).toBe("open-done");
    // One line for a burst, not one per failed accept.
    expect(log.filter((line) => line.includes("EMFILE"))).toHaveLength(1);
    expect(log.some((line) => line.includes("still listening"))).toBe(true);
    await listener.close();
  });
});
