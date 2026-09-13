import { z } from "zod";
import { defineTool } from "./_define";
import { tachoCommandFetch } from "../tacho.command.fetch";
import { commandStatusSchema } from "./dispatch-command";

/**
 * Appendix E: `fetch_commands` — "control channel; headless". Absorbs
 * `fetch_tacho_commands`.
 *
 * The idle half of the control channel (§7.4): an active host gets its commands
 * on the ingest response, and a host with nothing to report long-polls here
 * instead. Two things travel in one call — the outcomes of commands the host
 * already applied, and the pending ones — because splitting them would let a
 * host acknowledge a command and then never be told about its replacement.
 *
 * **The one carry change: acknowledgements speak §7.4's vocabulary.** v1
 * acknowledged with `tachoCommandOutcomeSchema.exclude(["pending"])`, which is
 * `delivered | applied | expired | failed`. Two of those a host cannot honestly
 * report: `expired` is Oxagen's clock, not the host's, and `delivered` is the
 * merge of `sent`, `received` and `acknowledged` that §7.4 exists to pull
 * apart. The status enum is imported from `dispatch-command.ts` — one
 * vocabulary, declared once — and narrowed with `extract` to the four words a
 * connection point is in a position to assert about itself.
 *
 * **Headless**, per Appendix E, so the surface list is one entry and there is
 * no agent grade to give: the caller is a daemon holding a host credential.
 */
export const fetchCommands = defineTool({
  name: "fetch_commands",
  domain: "control",
  description:
    "Acknowledge applied commands and fetch the pending ones with the host's control envelope.",
  mode: "sync",
  // Headless (Appendix E). Machine-to-machine only.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  // The control channel is how a `pause` or a `revoke` reaches a running
  // agent. Gating it on credit balance would mean a lapsed invoice leaves an
  // agent unstoppable. Carried from v1.
  noBillingGate: true,

  absorbs: ["fetch_tacho_commands"],
  drops: [
    {
      field: "acknowledgements[].outcome",
      from: "fetch_tacho_commands",
      why: "the value set changes, not the field: `tachoCommandOutcomeSchema` is replaced by §7.4's closed status vocabulary, narrowed to what a host can assert (`received`, `acknowledged`, `applied`, `failed`). `expired` is Oxagen's clock and `delivered` is the merge §7.4 forbids.",
    },
  ],

  // Carried unchanged from `fetch_tacho_commands`. High because the response
  // carries the control envelope — host status, deny generations, bundle etag
  // — which is the state a connection point fails closed against.
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // Writes the acknowledgements onto control.commands and stamps the host's
  // liveness and daemon health.
  mutates: true,

  input: z.object({
    // Kept snake_case: this is the wire document a daemon posts, and the field
    // is spelled this way in every deployed collector.
    host_enrollment_id: tachoCommandFetch.input.shape.host_enrollment_id,

    /**
     * Up to 100 per call, defaulting to none so a pure long-poll is a valid
     * body. The entry shape is the v1 one with a single leaf swapped, reached
     * by `omit`/`extend` rather than retyped: `command_id`'s bound, the
     * 512-char detail cap, `applied_at_seq` and `session_uuid` all keep their
     * definitions, and the object stays `strict` so an unknown key from an
     * out-of-date collector is refused rather than silently ignored.
     *
     * `applied_at_seq` is Appendix A.6's column: the frame sequence the effect
     * landed on. It is what makes "did the agent see it" answerable by
     * pointing at a frame rather than by asserting it (§7.6).
     */
    acknowledgements: z
      .array(
        tachoCommandFetch.input.shape.acknowledgements
          .removeDefault()
          .element.omit({ outcome: true })
          .extend({
            /**
             * §7.4, narrowed to the four a connection point can honestly
             * report about itself. `applied` is the only success word, and it
             * means the effect is visible in the record — the `model.request`
             * carrying the steer was made, or the pause took hold.
             */
            status: commandStatusSchema.extract([
              "received",
              "acknowledged",
              "applied",
              "failed",
            ]),
          }),
      )
      .max(100)
      .default([]),

    /**
     * Daemon health, carried whole. `spool_depth` and `hooks_ok` are the fleet
     * signals §7.1 grades a run's enforcement tier from, and `hooks_ok: false`
     * is how a stripped-hooks host is caught (§7.4's `hooks_removed`).
     */
    daemon: tachoCommandFetch.input.shape.daemon,
  }),

  output: z.object({
    acknowledged: tachoCommandFetch.output.shape.acknowledged,
    /** Host status, deny generations, bundle etag, and the pending commands. */
    control: tachoCommandFetch.output.shape.control,
  }),
});

export type FetchCommandsInput = z.output<typeof fetchCommands.input>;
export type FetchCommandsOutput = z.output<typeof fetchCommands.output>;
