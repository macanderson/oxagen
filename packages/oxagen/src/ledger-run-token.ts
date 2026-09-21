/** Reserved credential for one existing run attempt (ADR-056). */
export const LEDGER_RUN_SCOPE_PURPOSE = "ledger_run_v1";
export const LEDGER_RUN_TOKEN_TTL_MS = 15 * 60 * 1000;
export function requestsReservedLedgerRunPurpose(scope: unknown): boolean {
  return (
    typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    scope.purpose === LEDGER_RUN_SCOPE_PURPOSE
  );
}
