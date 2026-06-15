Multi-language code sample with per-language tabs (language glyphs), a copy button on the active tab, and a fade between languages — the dev-docs pattern.

```jsx
<CodeTabs tabs={[
  { language: "ts", label: "TypeScript", filename: "client.ts", code: `const ox = new Oxagen(key);\nawait ox.graph.query("MATCH (u:User) RETURN u");` },
  { language: "py", label: "Python", code: `ox = Oxagen(key)\nox.graph.query("MATCH (u:User) RETURN u")` },
  { language: "curl", label: "cURL", code: `curl https://api.oxagen.ai/v1/graph/query \\\n  -H "Authorization: Bearer $KEY"` },
]} />
```

- Each tab: `{ language, label?, filename?, code }`. `language` drives the glyph (ts/js/py/go/rust/bash/json/sql/cypher/graphql/curl…).
- For a single listing use `CodeBlock`. Requires framer-motion (`window.Motion`) for the fade.
