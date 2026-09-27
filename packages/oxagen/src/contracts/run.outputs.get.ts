/**
 * `get_run_outputs`: what a run produced, in the order it produced it
 * (the run mockup's `<RunOutputs>`; Option Story, decided 2026-09-17).
 *
 * The Run page's spine. One node per thing the run produced, ordered by the
 * frame that produced it, each carrying a kind, a name, where it landed, a
 * state, a one-line note, a diff stat on a file, and the frame sequence the
 * `fr N` chip opens. A read is never a durable node: it comes back as a
 * `read` node so the surface can draw the hairline tick and honour the tally,
 * and it is never counted as an artifact.
 *
 * ## One node shape over two stores
 *
 * A wrapped session (`tse_…`) reads `tacho.session_files`: one row per path
 * the session touched, with its counters, its diff stat, git's word for what
 * happened to it, and the first and last frame that touched it. That row
 * carries a path, so a wrapped node names a file.
 *
 * A ledger run (`arun_…`) reads its `change.recorded` and
 * `provider_publish.*` frames. **A ledger change cannot name a file.** The
 * event carries `path_locator_public_id`, an opaque `rpl_` locator, and the
 * exact path is deliberately never part of the event (spec §"Change
 * receipt"); nothing in the database resolves the locator back to a path.
 *
 * Of the two readings the design could take — name the node by its locator,
 * or give ledger runs a different node shape with the commit and
 * pull-request nodes carrying the weight — this contract takes the first,
 * and keeps the commit and pull-request nodes as well. A change the ledger
 * recorded is a thing the run produced, and dropping it because its path is
 * unrecorded would make a run that changed eleven files read as a run that
 * changed nothing. So the node names the locator and sets `nameIsLocator`,
 * which is the surface's instruction to say the ledger records a change
 * without its path rather than to render `rpl_…` as if it were a filename.
 * Every badge still shows the recorded value and nothing stronger.
 *
 * ## Where a gate sits
 *
 * A governed gate is a parked or refused call on this run
 * (`agent.approval_requests.run_public_id`). The row carries no frame
 * sequence, so a gate node carries `seq: null` and sits after every frame
 * node and before the seal — which is where it stopped the run: nothing
 * after it happened. Each gate is followed by a `would` node naming the
 * capability that has *not* run.
 *
 * API only, and no MCP surface: this is a console read of one run's record,
 * and MCP is where agents connect.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";

/**
 * What a node is. `change` is the ledger's pathless change receipt; `file`
 * and `media` are a wrapped session's paths, split so a surface can show an
 * asset rather than name it (#3608 gives `media` its thumbnail).
 */
export const RUN_OUTPUT_KINDS = [
  "file",
  "media",
  "change",
  "commit",
  "pr",
  "gate",
  "would",
  "read",
] as const;
export type RunOutputKind = (typeof RUN_OUTPUT_KINDS)[number];

/**
 * The kinds a reader would go and open. The tally's `artifacts` counts
 * these and nothing else, which is why a read, a gate and a withheld
 * "would" are excluded: none of them is a thing the run produced.
 */
export const RUN_OUTPUT_DURABLE_KINDS = [
  "file",
  "media",
  "change",
  "commit",
  "pr",
] as const satisfies readonly RunOutputKind[];

/** The badge on a node: the recorded disposition, never an inference. */
export const RUN_OUTPUT_STATES = [
  "created",
  "written",
  "deleted",
  "renamed",
  "pushed",
  "open",
  "read",
  "awaiting",
  "blocked",
  "withheld",
] as const;
export type RunOutputState = (typeof RUN_OUTPUT_STATES)[number];

/** Lines added and removed, as the recorder counted them. */
const diffStatSchema = z
  .object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  })
  .strict();

const runOutputNodeSchema = z
  .object({
    /**
     * The frame that produced it, decimal, so the `fr N` chip opens the
     * transcript there. Null on a gate and its `would`: the approval record
     * carries no frame sequence, and a position must not be invented. On a
     * node a subagent chain produced, it is the frame's position on that
     * chain, and `sessionUuid` names the chain.
     */
    seq: z.string().regex(/^\d+$/).nullable(),
    /**
     * The subagent chain that produced the node; absent on the run's own
     * chain. A subagent chain numbers its frames from 0, so `seq` names a
     * frame only together with this (#3823).
     */
    sessionUuid: z.string().uuid().optional(),
    kind: z.enum(RUN_OUTPUT_KINDS),
    /**
     * The mono name: a repository-relative path, a commit sha, `#482`, the
     * capability a gate parked, or — on a ledger change — the `rpl_` path
     * locator. Read `nameIsLocator` before rendering it as a filename.
     */
    name: z.string().min(1),
    /**
     * True when `name` is an opaque path locator and not a path, which is
     * every ledger `change` node: the ledger records a change without its
     * path, and the surface says so rather than dressing the locator up.
     */
    nameIsLocator: z.boolean(),
    /**
     * Where it landed: a repository id on a commit or a pull request, the
     * language on a file, `oxagen` on a gate. Null where the record says
     * nothing, which is never rendered as a blank guess.
     */
    where: z.string().nullable(),
    state: z.enum(RUN_OUTPUT_STATES),
    /** One line from the record; null when it carries none. */
    note: z.string().nullable(),
    /** A file's diff stat; null on every node the recorder counted no lines for. */
    stat: diffStatSchema.nullable(),
    /** RFC 3339; null where the store recorded no instant for the node. */
    observedAt: z.string().datetime({ offset: true }).nullable(),
    /** sha256 before and after, where the record carries them. */
    digestBefore: z.string().nullable(),
    digestAfter: z.string().nullable(),
  })
  .strict();

export type RunOutputNode = z.output<typeof runOutputNodeSchema>;

/** The header's count: `3 artifacts · 2 reads · 1 gate`. */
const tallySchema = z
  .object({
    artifacts: z.number().int().nonnegative(),
    reads: z.number().int().nonnegative(),
    gates: z.number().int().nonnegative(),
  })
  .strict();

/** The most nodes one read returns; past it the spine is a prefix and says so. */
export const RUN_OUTPUT_NODE_MAX = 500;

export const runOutputsGet = registerCapability({
  name: "get_run_outputs",
  domain: "run",
  description:
    "Read what one run produced, in the order it produced it: a file or media node per path a wrapped session wrote, a change, commit and pull-request node per receipt a ledger run recorded, a read node per path the run only looked at, and a gate node where a governed call stopped it.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ runId: runPublicIdSchema }).strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      /** Which store recorded the run, because the node shapes differ by store. */
      source: z.enum(["wrapped", "ledger"]),
      /**
       * The spine, in the order the run produced it: frame nodes by their
       * producing frame, then the gates that stopped the run, each followed
       * by the `would` node naming what did not happen.
       */
      nodes: z.array(runOutputNodeSchema),
      tally: tallySchema,
      /** False when the read stopped at its cap, so the spine is a prefix. */
      complete: z.boolean(),
    })
    .strict(),
});

export type RunOutputsGetOutput = z.output<typeof runOutputsGet.output>;
