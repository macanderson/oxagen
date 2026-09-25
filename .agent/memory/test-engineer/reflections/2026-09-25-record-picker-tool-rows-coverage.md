## Self-Evaluation — coverage audit of 9a9d514 (tool picker rows) — 2026-09-25
### What I set out to do
Rank untested behaviour in record-picker.tsx and choice-actions.ts after 9a9d514 and fill real gaps in their two test files.
### What I actually did (measurable deltas)
+19 cases in choice-actions.test.ts (16 -> 35 incl. it.each rows), +6 in record-picker.test.tsx (21 -> 27). All green. Mutation-checked four seams: context ranking, prefix-equal namespace guard, field icon while typing, classification-over-readOnly precedence; each new test went red on its mutation.
### Quality of my decisions
- Best: mutating the context-search branch showed the commit's own "finds a tool by the name of the server" test passes without context search, because the uuid slug value already contains "notion".
- Weakest: my first "icon leaves while typing" test used user.clear, which un-chooses the value, so it passed under mutation. Only the mutation check caught it.
### What I could have done better
- Read the onChange handler before writing an interaction test; clear-then-type exercises a different state than type-onto-name.
- Checked Badge for a data attribute before asserting on one (it has none); I asserted exact textContent instead.
### What surprised me about this codebase/product
titleOf strips the first word of the *source label* when a tool has no server ("Custom tool" strips "custom", "MCP server" strips "mcp"), and only the first word of a multi-word vendor ("Google Drive" leaves "Drive ...").
### Risks I am leaving behind (untouched on purpose, and why)
Reported, not pinned: titleOf multi-word vendor and source-label stripping (warts, maintainer choice), all-caps runs like HTTPRequest untouched, a prefilled namespaced value shows the raw uuid until load resolves, serversById rejection (throw, not Read error) fails the whole list via Promise.all.
### Confidence in the result: high — each new assertion mutation-verified or asserted on exact output; both files green in isolation.
