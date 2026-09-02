# @oxagen/skills

Agent skill definitions for the [Oxagen](https://docs.oxagen.sh) CLI.

## Install the skills

```sh
npx @oxagen/skills install
```

Copies the bundled skills into `~/.config/oxagen/skills`, where the `oxagen` CLI
finds them on its next run. Skills already in that folder are left alone unless
you pass `--force`.

```sh
npx @oxagen/skills list             # show the bundled skill definitions
npx @oxagen/skills install --dir ./.oxagen/skills   # project-local install
npx @oxagen/skills install --force  # overwrite existing files
```

## Install the CLI

```sh
curl -fsSL https://cli.oxagen.sh/install.sh | sh
```

See the [installation guide](https://docs.oxagen.sh/docs/cli/installation) for
all install methods, and the [CLI docs](https://docs.oxagen.sh/docs/cli) for
what to run next.

## What's inside

Each `skills/<slug>/skill.toml` file is one complete skill: some metadata plus
the instructions the agent follows. The bundled set covers entity resolution,
relationship extraction, summarization, coding, skill authoring, and more.

Give every skill its own directory directly under the skills root. The CLI only
looks one level deep, so it finds `skills/<slug>/skill.toml` but not
`skills/<category>/<slug>/skill.toml`.

The npm package ships only the installer and the skill definitions. The
TypeScript source in `src/` is used inside the Oxagen platform monorepo — mostly
`builtin.ts`, which reads the same skills from an embedded copy so they work in
serverless bundles — and is not published.
