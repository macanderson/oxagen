# API fixture and rollup review

Statically reviewed the API admission transport fixture and the daily cost-rollup timestamp correction for #4202. CI is not yet green, so this records source review approval rather than runtime validation.

| Severity | Location | Issue | Status |
| --- | --- | --- | --- |
| P2 | `apps/api/src/test-setup.ts` | Registering cleanup inside the asynchronous mock factory could register a hook while a test hook imports the app. | Corrected by the owner before approval |
| P2 | `apps/api/src/__tests__/admission-transport.ts` | Cleanup stopped at the first failed or locked stream. | Corrected by the owner; remaining streams are attempted and failures are reported together |
| P2 | `packages/billing/src/cost-rollup-store.pg.test.ts` | Count and cost assertions alone could miss a boundary inclusion error offset by an exclusion error. | Corrected by the owner with exact task-key equality |

The API fixture replaces only the default middleware instance and its pressure source. It still calls the production factory with production lane limits. The lifecycle tests construct explicit unwrapped gates. Finite responses are consumed before being returned as readable copies. SSE responses retain admission until cleanup. Added tests cover source failure propagation, streaming saturation, and detached work that must retain its reservation after the finite response drains. No production admission behavior is weakened.

The rollup query now uses Drizzle gte/lt operators on the timestamptz column, so Date bounds pass through its encoder. The half-open UTC interval is unchanged. The real Postgres regression includes midnight, the final millisecond of the day, the previous day's final millisecond, and the next midnight. Exact expected task keys prove that out-of-day rows cannot replace missing in-day rows unnoticed.

No remaining P0/P1 finding in either reviewed change. No local test, build, lint, or typecheck ran. Owners made the corrections; this reviewer changed only this report. The parent owns publication and CI verification. No PR was created by this reviewer.
