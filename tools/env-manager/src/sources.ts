import { randomBytes } from "node:crypto";
import type { ResolveResult, Source } from "./types";

// Resolve a Source to a concrete value. Values are returned to the server only —
// never serialized to the browser. `generate` produces a fresh secret each call,
// so the server must cache it per (key, env) to keep api/app consistent.
export async function resolveSource(src: Source): Promise<ResolveResult> {
  switch (src.type) {
    case "static":
      return { value: src.value };
    case "generate":
      return { value: randomBytes(src.bytes ?? 32).toString("hex") };
    case "manual":
      return { manual: true };
  }
}
