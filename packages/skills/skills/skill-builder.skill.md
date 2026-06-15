---
name: skill-builder
description: How to author a new skill — a versioned markdown knowledge artifact an agent loads at runtime. Covers the frontmatter shape, body structure, when a skill is worth writing, and how to keep it generic and token-efficient.
metadata:
  weight: high
  category: meta
---

# Building a skill

Load this skill when the user wants to create, edit, or improve a skill.
A skill is a small markdown document that teaches an agent *how* to do
something — a coding standard, a debugging method, a writing style. It is
knowledge, not an executable tool: loading it returns prose the model
reads and applies.

Skills are loaded lazily. The agent sees a one-line index (slug +
description) and pulls the full body only when a task calls for it, so a
skill earns its keep by being findable from its description and useful
once opened.

## Anatomy of a skill file

A skill is a single `*.skill.md` file: a YAML frontmatter block followed
by a markdown body.

```markdown
---
name: my-skill
description: One sentence a model can match against — what this skill is for and when to load it.
metadata:
  weight: high
  category: engineering
---

# Title

Body that teaches the behavior.
```

### Frontmatter fields

- **`name`** — the slug, lowercase kebab-case (`a–z`, `0–9`, `-`). It is
  the file's identity; the file is named `<name>.skill.md`.
- **`description`** — one sentence, written so the model can decide from
  it alone whether to load the skill. State what it covers *and* when to
  reach for it. This is the only part the agent sees before loading, so
  it does the discovery work.
- **`metadata.weight`** — `low`, `high`, or `critical`. How strongly the
  guidance should override the model's defaults. Reserve `critical` for
  rules that prevent real harm or breakage.
- **`metadata.category`** — a free-text grouping (`engineering`,
  `writing`, `meta`, your own domain). Used to organize skills in the UI.

## Writing the body

- **Open with when to load it.** The first lines should confirm the
  reader is in the right place and frame the task.
- **Lead each section with the rule, then the reason.** The model acts on
  the rule; the reason helps it apply judgement at the edges.
- **Be specific and imperative.** "Paginate every list endpoint" beats
  "consider performance". Vague guidance changes no behavior.
- **Stay generic and reusable.** Write for any project that fits the
  topic, not for one repository's private conventions. Hard-coded names,
  paths, or internal tools make a skill brittle and unshareable.
- **Keep it short.** Aim for one focused topic per skill, roughly one to
  two pages. If it sprawls across unrelated subjects, split it into
  several skills.

## Linking to other documents

To point at supporting material, add a `## References` section with a
markdown list of file paths relative to the skill file. The loader
resolves these lazily, so the bodies are only read when needed:

```markdown
## References

- ./style-guide.md
- ./examples/good-pr.md
```

## When NOT to write a skill

- The guidance is a one-off for a single task — say it inline instead.
- It belongs in code (a lint rule, a type, a test) — encode it there,
  where it is enforced rather than merely suggested.
- It duplicates an existing skill — improve that skill rather than
  forking a near-copy.

## Finishing up

Give the new skill a clear, matchable description, set an honest weight,
and confirm it loads cleanly. A good skill changes behavior the next time
a relevant task appears — if you cannot name the behavior it changes, it
is not ready.
