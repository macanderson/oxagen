---
name: clear-prose
description: >
  Rules for writing anything people will read from Oxagen or Stella. Use these
  when writing or editing a page, doc, post, email, README, changelog, UI text,
  error message, CLI output, or commit message.
---

# Clear prose

Use these rules any time you write for a reader: a web page, doc, post, email,
changelog, UI text, commit message, or anything else someone will read.

Start with what the reader needs—give the answer, fact, or step up front.
Match the structure to the task. Do not add a generic introduction if it does
not help.

**Audience and reading level**
- Write at a fifth-grade reading level. Use short sentences, familiar words,
  and plain names. Aim for clarity without a childish tone.
- Explain technical terms the first time you use them.
- Use examples anyone can understand.

**Voice and tone**
- Sound like an experienced technical writer. Be helpful and direct.
- Use contractions and natural sentence flow.
- Include details and rhythm if they help, but keep it clear.

# Writing rules

The full use and avoid lists, with replacements, are in the branding skill's
`references/words.md`, which lives in `macanderson/oxagen-brand` under
`skills/oxagen-branding/`. The stub at `.claude/skills/oxagen-branding/` says
how to read it from `main`.

- Always use plain nouns or noun phrases for names, headings, section labels,
  and table headers. For example: "Steering records" or "Deleted steering
  records," not "The records that steer."
- Use sentence case for headings, labels, buttons, and table headers.
- Use verbs for action elements like buttons or commands. For example:
  "Delete record," "Save changes."
- Use one name for each concept. Do not switch between "record," "entry,"
  and "resource" for the same thing.
- Write what something is, not just what you think someone might mean.
- Avoid inventing new terms for things with existing names.
- Spell out abbreviations or acronyms the first time. Only use them later if
  helpful.

## Actions and sentences

- Use direct, active voice. "The agent deletes the record," not "The record is
  deleted by the agent."
- Keep subject and verb close together.
- Describe steps in the order they happen. For example: "Choose a file, then
  select Upload."
- When explaining why something happened, put the cause before the effect when
  that makes the explanation easier to follow.
- Give each sentence one idea.
- Vary sentence length for flow, but keep most under 20 words.
- Make references clear. Use the actual name instead of "it" or "they" if the
  meaning is unclear.
- Use numbers for steps in a process, priorities, or items readers may need
  to reference later. Use bullets for unordered lists.

## Claims, facts, and technical language

- State facts directly: "Only admins can delete records."
- Make only claims the evidence supports. Never invent numbers or remove
  uncertainty to make a sentence sound stronger.
- Replace vague claims with specifics, if true: "Setup takes three steps."
- Use technical terms only if needed. Explain unfamiliar words the first time.
- Give everyday examples if the concept is hard.
- Do not add empty introductions ("It is important to note"), empty praise
  ("robust"), or slogans.
- Do not use metaphors or clever labels for actions or instructions. Prefer
  direct labels: "Activity history," not "Your work’s memory."

## Words and punctuation to avoid

- Avoid industry jargon or brand terms unless required and accurate.
- Do not use "very," "powerful," "eliminates," or similar claims unless
  precise and true.
- Use em dashes and exclamation points very sparingly, if at all. Prefer other
  punctuation and sentence structures in almost all cases.
- Do not ban words just for existing—cut empty or unsupported uses.

## Errors and messages

- Make error messages helpful. Say what went wrong and what to do now.
- Always include any facts readers need about costs, loss of access or data,
  and recovery—even if the message is longer as a result.

## Review

- Do all section headings and labels use plain nouns or noun phrases?
- Do buttons and commands use clear verbs?
- Does each concept have the same name throughout?
- Is the reading level simple enough for a fifth grader to understand?
- Can the reader always tell who does what and why?
- Are unfamiliar technical terms explained in plain language?
- Can any words be removed without losing meaning or natural flow?

Is the text free of extra words while preserving meaning and natural flow?
If the answer to any is **no, edit until it is clear**.
