# Production App Audit Results — Group B

## kn-graph — /thomas-anderson-mac/default/knowledge/graph
- Status: OK
- Preview/mock: NO
- Console: none
- Forms: none
- Bugs: none
- Notes: Graph view rendered. Shows empty state (NODES: 0, EDGES: 0, INFERRED: 0, SOURCES: 0). Pending Inferences and Approved Edges sections present but empty. No data loaded yet (expected for test workspace).

## kn-nodes — /thomas-anderson-mac/default/knowledge/nodes
- Status: ERROR: 404 NOT FOUND
- Preview/mock: NO
- Console: none
- Forms: none
- Bugs: P1: Route returns 404 "Page not found — The page you're looking for doesn't exist or has moved"
- Notes: Route /thomas-anderson-mac/default/knowledge/nodes does not exist or is not mounted. Users cannot access knowledge nodes view.

## kn-memories — /thomas-anderson-mac/default/knowledge/memories
- Status: OK
- Preview/mock: YES "Preview - not yet saved to live data"
- Console: none
- Forms: none
- Bugs: none
- Notes: Preview/static-mock page. Shows 5 memories (pinned + all categories). Displays: "Memories let workspace-enabled rules, facts, preferences, and agent-proposed lessons. Memories persist across conversations and power every agent's act in the workspace." Static data; Agent-proposed, User-authored, Fact, Reference, Lesson categories shown.

## kn-sources — /thomas-anderson-mac/default/knowledge/sources
- Status: OK
- Preview/mock: NO
- Console: none
- Forms: none
- Bugs: none
- Notes: Live data page. Shows 2 connected GitHub sources (one "delisting", one "Pending Setup"). Synced: 0, Total records: 0. Connect source button functional. Real workspace integration data visible.

## studio-compose — /thomas-anderson-mac/default/studio/compose
- Status: OK
- Preview/mock: YES "Preview - not yet wired to live data"
- Console: none
- Forms: Form tested — filled prompt field, "Generate" button present (~2 credits, 5-20 seconds). Submit skipped (may consume credits on non-preview). Image/Video/Document generation types available. Oxagen Default brand kit pre-selected. Form validation works.
- Bugs: none
- Notes: Preview/static-mock page. Shows generation prompt interface with brand kit selection (Oxagen Default). Placeholder text: "Generation preview appears here". Credit cost displayed. Form is wired but generation output is mocked.

## studio-library — /thomas-anderson-mac/default/studio/library
- Status: OK
- Preview/mock: YES "Preview - not yet wired to live data"
- Console: none
- Forms: none
- Bugs: none
- Notes: Preview/static-mock page. Displays 6 sample generations (Hero Image — Campaign Q2, Q2 product update email, Team photo background, Product demo, Competitive analysis, Social banner). Shows "Showing 6 generations. Assets are retained for 90 days on the current plan." Static sample library; no live generations saved.

