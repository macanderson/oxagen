import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { createRequestWork, trackRequestWork, type RequestWork } from "@oxagen/config/request-work";
import {
  createRequestAdmission,
  MCP_ADMISSION_LANES,
} from "@oxagen/telemetry/request-admission";

export const mcpAdmission = createRequestAdmission(MCP_ADMISSION_LANES);

/** The adapter can send an error without settling its dispatch promise. */
export function trackMcpDispatch(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    let ended: () => void = () => undefined;
    const endCalled = new Promise<void>((resolve) => { ended = resolve; });
    const originalEnd = res.end;
    const observedEnd = new Proxy(originalEnd, {
      apply(target, receiver: Response, args: unknown[]): unknown {
        try {
          const result: unknown = Reflect.apply(target, receiver, args);
          return result;
        } finally {
          ended();
        }
      },
    });
    res.end = observedEnd;
    try {
      await trackRequestWork(() => Promise.race([
        Promise.resolve(handler(req, res, next)),
        endCalled,
      ]));
    } catch (error) {
      next(error);
    } finally {
      if (res.end === observedEnd) res.end = originalEnd;
    }
  };
}

/** Own the HTTP boundary so admission runs before the framework parses JSON. */
export function createMcpHttpApp(
  middleware: RequestHandler[],
  handler: RequestHandler,
  admission = mcpAdmission,
  homePage?: string,
): Express {
  const app = express();
  const workByRequest = new WeakMap<Request, RequestWork>();
  const scoped = (step: RequestHandler): RequestHandler => (req, res, next) => {
    const work = workByRequest.get(req);
    if (work === undefined) {
      next(new Error("The request has no admission reservation."));
      return;
    }
    return work.run(() => trackRequestWork(() => step(req, res, next)).catch(next));
  };
  app.disable("x-powered-by");
  if (homePage !== undefined) app.get("/", (_req, res) => { res.type("html").send(homePage); });
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "streamable-http", mode: "stateless" });
  });
  app.get("/ready", (_req, res) => {
    const { ready } = admission.snapshot();
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "busy" });
  });
  const challenge = process.env.OPENAI_APPS_VERIFICATION_TOKEN;
  if (challenge) {
    app.get("/.well-known/openai-apps-challenge", (_req, res) => {
      res.type("text/plain").send(challenge);
    });
  }
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST");
    res.setHeader("Access-Control-Allow-Headers", [
      "Content-Type", "Authorization", "mcp-session-id", "mcp-protocol-version",
      "x-mcp-client-name", "x-mcp-client-version", "x-mcp-client-title",
      "x-mcp-client-website-url", "x-mcp-client-description",
    ].join(","));
    res.setHeader("Access-Control-Expose-Headers", "Content-Type,Authorization,mcp-session-id,Retry-After");
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    const lane = req.path.startsWith("/v1/local-servers/") ? "control" : "tool";
    const release = admission.acquire(lane);
    if (release === null) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "The service is at capacity. Retry after 2 seconds.",
          data: { code: "service_overloaded", retryAfterSeconds: 2 },
        },
      });
      return;
    }
    const work = createRequestWork(release);
    workByRequest.set(req, work);
    res.once("finish", () => work.close());
    res.once("close", () => work.close());
    work.run(next);
  });
  app.use(express.json({ limit: 4 * 1024 * 1024, inflate: false }));
  for (const step of middleware) {
    app.use(scoped(step));
  }
  app.all("/mcp", scoped(trackMcpDispatch(handler)));
  return app;
}
