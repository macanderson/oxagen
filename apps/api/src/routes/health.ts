import { Hono } from "hono";
import type { AppEnv } from "../app.js";

export const health = new Hono<AppEnv>();

health.get("/", (c) => c.json({ status: "ok" }));
