A knowledge-graph node reference — typed color dot + mono node id — as used in semantic edge diagrams and agent tool output.

```jsx
<NodeChip kind="user" label="Ada L." id="prn_8fa21c" />
<NodeChip kind="document" id="doc_41be09" />
```

- `kind`: `user` (cyan) · `document` (violet) · `service` (green) · `policy` (rose) · `resource` (amber) · `default`
- `id`: mono node id with a typed prefix; `label`: optional human name shown before it.
- Pair with `ConfidenceBar` to render an inferred edge: `NodeChip → relationship → NodeChip` + score.
