# WAL body failure

A body-first append can leave an orphan body on process death. It does not guarantee that the event survives a body-write exception. Keep the event write reachable, and isolate torn optional-content records from the next append across process restart. Preserve strict event-chain parsing.
