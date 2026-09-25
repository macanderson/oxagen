/**
 * `cancel_assistant_turn`: stop an `ask_assistant` turn that is still
 * running, named by the `turnId` its caller minted and passed with the
 * question (#4164).
 *
 * Only the person who asked can stop the turn, and only in the workspace
 * they asked in. The key the handler looks up is the organisation, the
 * workspace, the acting user and the turn id together, so another person's
 * request never matches. It answers `found: false` rather than refusing,
 * which also means a caller cannot learn whether someone else's turn exists.
 *
 * The stop is idempotent. A turn that already ended, a second stop, and a
 * stop that arrives before the turn has registered all answer without error.
 * A stop that arrives first is held for a minute, and the turn stops as soon
 * as it registers. `found` says whether a running turn took the stop.
 *
 * The stopped turn cancels its engine turn, keeps whatever reply the engine
 * wrote, and seals its run `cancelled` with the reason. `ask_assistant`
 * returns with `stopped: true`. Closing the flyout or leaving the page never
 * calls this: a turn keeps running when the person walks away (ADR-092).
 *
 * The running turns are held in the memory of the process that runs them, so
 * the stop must reach that process. Production runs one app node. A second
 * replica would need the stop routed to the replica that holds the turn.
 *
 * A control on a turn is not a governed action and spends nothing:
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const assistantTurnCancel = registerCapability({
  name: "cancel_assistant_turn",
  domain: "assistant",
  description:
    "Stop a running in-app agent turn that you asked, named by the turnId passed to ask_assistant. The turn keeps the reply written so far and its run is sealed cancelled. Idempotent.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** The `turnId` the caller passed to `ask_assistant`. */
      turnId: z.string().uuid(),
    })
    .strict(),
  output: z
    .object({
      turnId: z.string().uuid(),
      /**
       * True when a running turn of yours took the stop. False when none is
       * running under this id: it already ended, it was already stopped, or
       * it has not registered yet (the stop is then held and applied when it
       * does).
       */
      found: z.boolean(),
    })
    .strict(),
});

export type AssistantTurnCancelInput = z.output<
  typeof assistantTurnCancel.input
>;
export type AssistantTurnCancelOutput = z.output<
  typeof assistantTurnCancel.output
>;
