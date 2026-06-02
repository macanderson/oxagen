import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { ResolveResult, Source } from "./types";

const run = promisify(execFile);
const MAX = 1024 * 1024;

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
    case "gsm":
      try {
        const { stdout } = await run(
          "gcloud",
          ["secrets", "versions", "access", "latest", `--secret=${src.secret}`],
          { maxBuffer: MAX },
        );
        const value = stdout.replace(/\n$/, "");
        return value ? { value } : { error: `GSM secret "${src.secret}" is empty` };
      } catch (e) {
        return { error: `GSM "${src.secret}": ${(e as Error).message.slice(0, 140)}` };
      }
    case "neon":
      try {
        const args = ["connection-string", "--project-id", src.project, "--output", "json"];
        if (src.role) args.push("--role-name", src.role);
        if (src.database) args.push("--database-name", src.database);
        const { stdout } = await run("neonctl", args, { maxBuffer: MAX });
        const value = stdout.trim().replace(/^"|"$/g, "");
        return value ? { value } : { error: "neonctl returned empty" };
      } catch (e) {
        return { error: `neonctl: ${(e as Error).message.slice(0, 140)}` };
      }
  }
}
