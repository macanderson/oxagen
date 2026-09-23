# get_steering_deliveries

Read the latest verified steering manifest per run in the last 1 to 30 days. The default window is 7 days.

**Surfaces:** api, mcp

POST `/v1/context/steering/deliveries` with `days` and `limit`. The response names included records, cut records, budget cuts, and the budget used for each run. It also lists records absent from every sampled manifest that considered them.

The read examines up to 2,000 manifests. `scanned` states the sample size. `truncated` is true when the window contains more manifests. Missing manifests are unrecorded, so an empty response does not mean no steering reached an agent.

The Steering page exposes this read on its Delivery tab. The tenant scope bounds the ClickHouse query. This read consumes no credits.
