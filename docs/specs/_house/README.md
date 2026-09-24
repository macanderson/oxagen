# The Oxagen document kit

Every spec and plan in this folder is written in markdown and rendered to HTML
with one shell, so they all carry the same branding.

- `oxagen-doc.css` is the stylesheet: the house tokens (paper and ink, one gold)
  and the docs.oxagen.sh treatment (8, 12, and 16 px corners, the gold sheen only
  on a title's accent word). Light by default, dark by system setting.
- `render.py` turns `doc.md` into `doc.html` beside it. The first `# ` line is
  the title. The table right under it is the facts block (Status, Date, Owner,
  Source, and so on). Every `##` becomes a line in the contents rail.

```sh
python3 docs/specs/_house/render.py docs/specs/oxagen-desktop/spec.md
python3 docs/specs/_house/render.py some-doc.md --kind Plan --out elsewhere/some-doc.html
```

## How a document is written

- Title: `# Oxagen <Name>: <what the document is>`. No dashes in titles.
- Facts table right under the title, in this order when present: Status, Date,
  Owner, Source, Builds on, Related, Amended.
- Prose rules, from the brand voice guide: short sentences, plain words, define a
  term the first time it appears, Oxford commas, and no em-dashes anywhere. Use a
  comma, a period, a colon, or parentheses instead. State facts; do not hedge.
- Tables carry facts, prose carries reasons. An empty cell reads `none`, not a dash.
