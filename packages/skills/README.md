# @oxagen/skills

Agent skill definitions for the [Oxagen](https://docs.oxagen.sh) CLI.

## Install the skills

```sh
npx @oxagen/skills install
```

Copies the bundled `skill.toml` bundles into `~/.config/oxagen/skills`, where the
`oxagen` CLI discovers them automatically on its next run. Existing files are
left untouched unless you pass `--force`.

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

Each `skills/<slug>/skill.toml` file is a self-contained canonical skill
manifest (metadata plus instructions) the Oxagen agent loads at startup — entity resolution,
relationship extraction, summarization, coding, skill authoring, and more.

The library source in this package (loader, registry, seeding) is used by the
Oxagen platform monorepo and is not part of the published artifact — the npm
package ships only the installer and the skill definitions.
