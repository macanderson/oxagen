# Root agent lessons

- [2026-09-22] Stamp a context record's `record_id` and `record_hash` with RFC 8785 over the parsed object, not over the TOML bytes. Check the result against an existing `.oxagen/rules/*.toml` file before writing a new one. (source: reflections/2026-09-22-scr-toml-steering-records.md, agent: root)
- [2026-07-21] Before calling a portable artifact canonical, distinguish filesystem ownership from managed immutable source versions and transactional database projections. (source: reflections/2026-07-21-toml-artifacts-lifecycle-design.md, agent: root)
- [2026-09-20] Read an issue's decision comments and accepted ADRs before implementing its body: #3098's body describes an inventory page, while later decisions move Skills under Steering and expand it to repository-backed resolution. (source: reflections/2026-09-20-issue-3098-skills-redirect.md, agent: root)
- [2026-09-19] When an uncontrolled form submits an optimistic-concurrency baseline, snapshot the baseline when the form opens; a later prop refresh can otherwise change the token without changing the visible fields. (source: reflections/2026-09-19-approval-rule-review-fixes.md, agent: root)
