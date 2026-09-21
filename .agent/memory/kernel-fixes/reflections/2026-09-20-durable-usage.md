# Durable usage settlement

The #2972 audit found independent swallowed telemetry and credit writes in all three AI wrapper paths. Added durable admission and a temporary Postgres delivery body before atomic settlement, with a stable call UUID separate from message correlation. Counter, fractional carry, credit lots, ledger, and settlement marker use one transaction. The delivery worker retries the same ID into a ClickHouse FINAL read view.

AI SDK 7 notify() swallows lifecycle callback errors. The awaited prepareStep hook admits streaming calls before the provider. A real SDK regression uses a refusing admission and asserts no provider call. Completed-step usage survives cancellation and later-step errors. Unknown interrupted usage remains an incomplete admission for reconciliation.

Atlas generated the table diff against an isolated minimal desired schema. The temporary local database was dropped. RLS came from the repository generator. No production migration ran. Independent test-engineer review required balance/carry rollback assertions and a later-step error witness; both were added. No local tests ran beyond the task's earlier one-file allowance. CI remains required.
