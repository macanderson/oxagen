import { defineTool } from "./_define";
import { tachoCommandFetch as live } from "../tacho.command.fetch";

/**
 * Appendix E: `fetch_commands` — "control channel; headless". Absorbs
 * `fetch_tacho_commands`.
 *
 * This tool is live: issue #2953 registered it in place, in
 * ../tacho.command.fetch.ts, under its Appendix E name, and the v1
 * `fetch_tacho_commands` no longer exists. The descriptor composes from the
 * live contract so the carry checks in this directory keep reading one
 * schema, and it is not registered a second time.
 *
 * The one carry change: acknowledgements speak §7.4's vocabulary. v1
 * acknowledged with `outcome` from `delivered | applied | expired | failed`,
 * two of which a host cannot honestly report — `expired` is Oxagen's clock,
 * and `delivered` is the merge of `sent`, `received` and `acknowledged` that
 * §7.4 exists to pull apart. The body now carries `schema:
 * "tacho.commands.v2"`, which is the collector protocol bump.
 */
export const fetchCommands = defineTool({
  name: live.name,
  domain: live.domain,
  description: live.description,
  mode: live.mode,
  surfaces: live.surfaces,
  layers: live.layers,
  scoped: live.scoped,
  noBillingGate: live.noBillingGate,

  absorbs: ["fetch_tacho_commands"],
  renames: [
    {
      from: "outcome",
      source: "fetch_tacho_commands",
      to: "status",
      why: "the value set changes with the field: `tachoCommandOutcomeSchema` is replaced by §7.4's closed status vocabulary, narrowed to what a host can assert (`received`, `acknowledged`, `applied`, `failed`).",
    },
  ],
  drops: [],

  sensitivity: live.sensitivity,
  defaultEffect: live.defaultEffect,
  defaultRoles: live.defaultRoles,
  mutates: live.mutates,
  input: live.input,
  output: live.output,
});

export type {
  FetchCommandsInput,
  FetchCommandsOutput,
} from "../tacho.command.fetch";
