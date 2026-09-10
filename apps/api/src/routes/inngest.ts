import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { inngest, functions } from "@oxagen/inngest-functions";
import type { AppEnv } from "../app";

// Inngest serve handler. Inngest cloud polls GET to discover function
// manifests, then PUTs/POSTs to invoke. Signing-key verification happens
// inside the handler when INNGEST_SIGNING_KEY is set.
//
// serveHost/servePath are pinned rather than derived from the incoming
// request. During a sync the SDK tells Inngest which URL to call back on, and
// without these it reads that URL out of the request's own headers — so a
// sync triggered from inside the node (`curl 127.0.0.1:4000/api/inngest`, the
// natural thing for a post-deploy step to do) registers a loopback address
// Inngest can never reach, and every function silently stops being invoked.
// NEXT_PUBLIC_API_URL is the public origin this service already answers on.
const serveHost = (() => {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
})();

export const inngestRoute = new Hono<AppEnv>();

inngestRoute.on(["GET", "POST", "PUT"], "/", (c) =>
  inngestServe({
    client: inngest,
    functions,
    ...(serveHost ? { serveHost } : {}),
    servePath: "/api/inngest",
  })(c),
);
