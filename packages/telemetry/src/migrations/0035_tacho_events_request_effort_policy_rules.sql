-- 0035_tacho_events_request_effort_policy_rules.sql
--
-- Two body members for the Run page's evidence tabs.
--
-- request_effort (#3891, ADR-201) is the reasoning effort a proxied model
-- request's body asked for, as the vendor received it: Anthropic
-- `output_config.effort`, OpenAI Responses `reasoning.effort`, or Chat
-- Completions `reasoning_effort`. The model proxy seals it on the `llm_call`
-- frame. `get_run` reads it ahead of the harness's own report of the effort.
--
-- policy_rules (#3971, ADR-201) is the rules that decided a call, in
-- evaluation order: one for a deny or an ask, and each shell segment's rule,
-- once, for a compound allow. `policy_rule` keeps the joined form for older
-- readers.
--
-- Why this file exists beside 0027. 0027 is GENERATED from the @oxagen/tacho
-- envelope, so adding a body member rewrites it, and a cluster that already
-- applied 0027 skips the rewritten file and never gets the columns. This one
-- carries the two columns forward to every cluster bootstrapped before them.
-- Idempotent, so the order of the two on a fresh cluster does not matter.
--
-- Backfill: none. An empty request_effort means Oxagen read no effort from
-- the request. A row sealed before policy_rules reads its joined policy_rule
-- as a list of one. `readSessionConfig` selects request_effort by name, so
-- this migration reaches production before or with the handlers that read it.
ALTER TABLE tacho_events
  ADD COLUMN IF NOT EXISTS request_effort String AFTER workspace_host_paths,
  ADD COLUMN IF NOT EXISTS policy_rules Array(String) AFTER policy_rule;
