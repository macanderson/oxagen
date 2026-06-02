import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { inngest, functions } from "@oxagen/inngest-functions";
import type { AppEnv } from "../app";

// Inngest serve handler. Inngest cloud polls GET to discover function
// manifests, then PUTs/POSTs to invoke. Signing-key verification happens
// inside the handler when INNGEST_SIGNING_KEY is set.
export const inngestRoute = new Hono<AppEnv>();

inngestRoute.on(["GET", "POST", "PUT"], "/", (c) =>
  inngestServe({ client: inngest, functions })(c),
);
