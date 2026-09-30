---
name: oxagen-branding
version: 1.0.0
scope: workspace
description: The authority for anything that carries Oxagen or Stella branding or speaks in Oxagen's voice. Use it whenever you create or edit a page, post, ad, email, deck, doc, spec, UI string, error message, CLI output, README, or any prose a person will read on behalf of either brand, even if the request does not say "brand" or "voice". Covers the marks, tokens, type, layout rules, positioning, one-liners, voice and tone, words to use, words to avoid, and worked examples. Oxagen and Stella share one house system; the logo is the only difference.
---

# Oxagen branding

This skill holds the method. The brand itself lives in `macanderson/oxagen-brand` on `main`, and you read it from there every time. Never write brand copy, colours, or type from memory or from an older copy of a file.

## Get the brand

1. **Inside oxagen-brand**, when `git remote get-url origin` names `macanderson/oxagen-brand`, read the working tree. You are editing the source.
2. **Everywhere else**, pin one commit and read every file from it:

   ```sh
   sha=$(git ls-remote https://github.com/macanderson/oxagen-brand refs/heads/main | cut -f1)
   curl -fsSL "https://raw.githubusercontent.com/macanderson/oxagen-brand/$sha/skills/oxagen-branding/references/core.md"
   ```

   Use `curl` when you have a shell. A web-fetch tool may summarise what it reads, so without a shell ask it for the file verbatim.
3. **If the network fails**, use a local checkout (`$OXAGEN_BRAND_KIT`, else `~/Projects/oxagen-brand`): run `git -C <kit> fetch origin main`, then read each file with `git -C <kit> show origin/main:<path>`.
4. **If all three fail**, stop and say that the brand source is unreachable. Do not fall back to memory.

Name the commit in your reply or PR body: `Brand source: oxagen-brand@<first 7 of sha>`.

## Read these

Paths are from the repo root. Always read `skills/oxagen-branding/references/core.md` first. Then read the file for what you are making:

| Making | Read next |
|---|---|
| Anything with words in it | `skills/oxagen-branding/references/voice.md`, then `skills/oxagen-branding/references/words.md` |
| A headline, hero, ad, tagline, or the first sentence of anything | `skills/oxagen-branding/references/positioning.md` and `messages/index.json` |
| Anything about identity, access, credentials, connections, permissions, or tools | `skills/oxagen-branding/references/positioning.md`, the section *The keys stay with you* |
| Outreach, a sales brief, or anything that names who Oxagen sells to | `skills/oxagen-branding/references/positioning.md`, the section *The buyer we are built for* |
| A page, ad, deck, or UI | `skills/oxagen-branding/references/system.md` and `tokens/house-tokens.css` |
| Copy for a specific surface (site, ad, email, docs, UI, launch) | `skills/oxagen-branding/references/examples.md` |
| Always-on copy: agents that keep working after the operator's day ends | `skills/oxagen-branding/references/always-on.md`, then `skills/oxagen-branding/references/always-on-lines.md` |
| A change to the brand itself: a face, a colour, a line, a component | `CHANGING.md` |

## Lines

`messages/index.json` is the authority for every line either brand publishes. Each entry carries `status` (approved, candidate, retired) and `release` (launch, held). Ship only entries that are approved and released for launch. A held entry names its gate. Never use a retired entry: its `replaced_by` names what to use instead. When a reference and the registry disagree, the registry wins.

A new line or a changed line starts as an entry in `messages/`, never in a product's source. See `CHANGING.md`.

## Colours, type, and marks

Every value comes from `tokens/`: `house-tokens.css` and `house-tokens.json` for colour, `house-tailwind.css` for the type scales and utilities, `house-fonts.css` and `fonts/` for the faces. A product imports those files. It never retypes a value. Logos are in `logo/svg/`, icons and favicons in `icons/`.

## Where this skill lives

`skills/oxagen-branding/` in `macanderson/oxagen-brand` is the only full copy. Every other repo, and `~/.claude/skills/`, holds the stub from `skills/stub/oxagen-branding/`, which fetches this file from `main` and follows it. `skills/install.sh` installs the stub. Never vendor the references.
