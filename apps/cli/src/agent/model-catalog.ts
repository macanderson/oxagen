/**
 * The single source of truth for the latest-GA gateway slug of every model
 * family the CLI defaults to.
 *
 * Every default across the CLI (the cost router, the agent-loop default, the
 * scaffolded settings and agent files, the pipeline judge, the runtime
 * registry) imports the slug from here instead of hard-coding it. When a
 * provider ships a new GA version of a family (Sonnet 5 → Sonnet 6, Fable 5 →
 * Fable 6, …) you update EXACTLY ONE line below and every default across the
 * CLI moves with it.
 *
 * These are floating major-version aliases, not dated snapshots: the Vercel AI
 * Gateway resolves `anthropic/claude-sonnet-5` to the current Sonnet-5 build,
 * so "latest GA" is tracked without pinning a datestamp — the moment a family's
 * next major goes GA, bump its line here. Every consumer is still individually
 * env-overridable at its call site (`OXAGEN_LLM_*`, `OXAGEN_MODEL`) for gateway
 * slug drift ahead of a catalog bump.
 *
 * INVARIANT: the friendly-id slugs in `runtime/models.json` must match these
 * values. `model-catalog.test.ts` asserts it, so the two sources cannot drift.
 */

/**
 * Latest-GA Anthropic gateway slug per cost tier.
 *
 * Bump a line the instant that family's next major is GA.
 *
 * Fable is the flagship model and holds the precise/high-stakes tier. Every
 * default that needs that tier reaches for Fable via this one line.
 */
export const LATEST_ANTHROPIC = {
  /** Cheapest tier — mechanical / single-file work. */
  haiku: "anthropic/claude-haiku-4.5",
  /** Balanced tier — the general-purpose default coding model. */
  sonnet: "anthropic/claude-sonnet-5",
  /** Precise tier — high-stakes / architectural work (flagship Claude 5). */
  fable: "anthropic/claude-fable-5",
} as const;

/**
 * Latest-GA most-capable OpenAI coding model. Used as the cross-vendor judge
 * default (a judge that shares none of a Claude worker's blind spots) and as
 * System B's most-capable worker candidate.
 */
export const LATEST_OPENAI_CODING = "openai/gpt-5.5-pro";

/**
 * The CLI's default coding model — the balanced/Sonnet tier. Every default
 * model slug (agent loop, scaffolded settings, new-agent template) resolves to
 * this so a single Sonnet bump above propagates everywhere.
 */
export const DEFAULT_CODING_MODEL = LATEST_ANTHROPIC.sonnet;
