#!/usr/bin/env python3
"""Render an Oxagen spec or plan (markdown) as a self-contained HTML document.

    python3 _house/render.py path/to/doc.md            # writes doc.html beside it
    python3 _house/render.py doc.md --out other.html --kind Plan

The markdown carries its own facts: the first `# ` line is the title and the
table right under it (`| **Status** | Draft |` rows) is the metadata. Both are
lifted into the masthead. Everything after is the body; every h2 gets an id and
a line in the contents rail. The stylesheet (oxagen-doc.css) is inlined so the
file travels on its own.
"""
import argparse, datetime, html, pathlib, re, sys
from markdown_it import MarkdownIt

HERE = pathlib.Path(__file__).resolve().parent
CSS = (HERE / "oxagen-doc.css").read_text()

def slug(s):
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "section"

def split_front(md):
    """Return (title, facts:list[(k,v)], body_md)."""
    lines = md.splitlines()
    i = 0
    while i < len(lines) and not lines[i].strip(): i += 1
    if i >= len(lines) or not lines[i].startswith("# "):
        sys.exit("first non-blank line must be the `# Title`")
    title = lines[i][2:].strip(); i += 1
    while i < len(lines) and not lines[i].strip(): i += 1
    facts = []
    if i < len(lines) and lines[i].strip().startswith("|"):
        rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            rows.append(lines[i]); i += 1
        for r in rows:
            cells = [c.strip() for c in r.strip().strip("|").split("|")]
            if len(cells) < 2 or set(cells[0]) <= set("-: ") or not cells[0]: continue
            k = re.sub(r"^\*\*(.+)\*\*$", r"\1", cells[0])
            facts.append((k, "|".join(cells[1:]).strip()))
        while i < len(lines) and (not lines[i].strip() or lines[i].strip() == "---"): i += 1
    return title, facts, "\n".join(lines[i:])

def infer_kind(name, title):
    t = (name + " " + title).lower()
    for key, kind in [("scenario", "Scenario"), ("matrix", "Matrix"), ("audit", "Audit"),
                      ("plan", "Plan"), ("spec", "Specification"), ("design", "Design")]:
        if key in t: return kind
    return "Document"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("--out"); ap.add_argument("--kind")
    a = ap.parse_args()
    src = pathlib.Path(a.src)
    out = pathlib.Path(a.out) if a.out else src.with_suffix(".html")
    title, facts, body = split_front(src.read_text())
    kind = a.kind or infer_kind(src.name, title)
    md = MarkdownIt("commonmark", {"html": True}).enable(["table", "strikethrough"])
    inline = lambda s: md.renderInline(s)

    toc = []
    tokens = md.parse(body)
    seen = {}
    for j, tok in enumerate(tokens):
        if tok.type == "heading_open" and tok.tag in ("h2", "h3"):
            text = tokens[j + 1].content
            s = slug(text); n = seen.get(s, 0); seen[s] = n + 1
            if n: s = f"{s}-{n}"
            tok.attrSet("id", s)
            if tok.tag == "h2": toc.append((s, inline(text)))
    body_html = md.renderer.render(tokens, md.options, {})
    body_html = body_html.replace("<table>", '<div class="tw"><table>').replace("</table>", "</table></div>")

    facts_html = "".join(f"<dt>{html.escape(k)}</dt><dd>{inline(v)}</dd>" for k, v in facts)
    toc_html = "".join(f'<li><a href="#{s}">{t}</a></li>' for s, t in toc)
    today = datetime.date.today().isoformat()
    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(re.sub(r'<[^>]+>', '', inline(title)))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap">
<style>
{CSS}
</style>
</head>
<body>
<div class="wrap">
<header class="mast">
  <a class="wordmark" href="https://oxagen.sh">o<span class="x">x</span>agen</a>
  <p class="eyebrow">Oxagen · {html.escape(kind)}</p>
  <h1>{inline(title)}</h1>
  {'<dl class="facts">' + facts_html + '</dl>' if facts else ''}
</header>
<div class="grid">
<nav class="toc" aria-label="Contents"><p>Contents</p><ol>{toc_html}</ol></nav>
<main>
{body_html}
<footer class="colophon"><span>Oxagen · {html.escape(kind)}</span><span>Source: <code>{html.escape(src.name)}</code> · rendered {today}</span></footer>
</main>
</div>
</div>
</body>
</html>
"""
    out.write_text(doc)
    print(f"wrote {out} ({len(doc)//1024} KB, {len(toc)} sections)")

if __name__ == "__main__":
    main()
