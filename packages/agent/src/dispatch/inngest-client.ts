import { Inngest } from "inngest";
import { requireEnv } from "@oxagen/config/env";

// Shared lazy Inngest client. Initialized once on first use so the
// module-level requireEnv() only fires when the module is actually loaded,
// and we never create more than one Inngest instance per process.
let _inngest: Inngest | null = null;

export function getInngestClient(): Inngest {
  if (_inngest) return _inngest;
  const env = requireEnv(["INNGEST_EVENT_KEY"] as const);
  _inngest = new Inngest({
    id: "oxagen-runner",
    eventKey: env.INNGEST_EVENT_KEY,
  });
  return _inngest;
}
