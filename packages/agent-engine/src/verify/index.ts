/**
 * Mutation verifier — public surface.
 *
 * Layer 1 (`runMutationGate`): after a judged-complete round, revert the fix in
 * a shadow (test files stay put), re-run the agent's own witness test command,
 * and demand a failure. Still green without the fix ⇒ the turn is vacuous and
 * the verdict is overridden back into the revise loop.
 *
 * Layer 2 (`score: true`): deterministic patch-scoped mutation testing — how
 * many one-line mutants of the fix do the tests kill?
 */
export { runMutationGate, type MutationGateOptions } from "./gate";
export {
  parseUnifiedDiff,
  partitionByTestPath,
  reconstructOriginal,
  planWitnessCommands,
  hasWitnessClaim,
  witnessOutcome,
  applyGateToVerdict,
  resolveMutationVerifyEnabled,
  generateMutants,
  type DiffFile,
  type DiffHunk,
  type Mutant,
  type MutationGateResult,
  type MutationGateStatus,
  type MutationScore,
  type TestEvidence,
  type WitnessRun,
  type GateableVerdict,
} from "./mutation";
