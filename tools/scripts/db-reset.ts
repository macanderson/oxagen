#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";
import { formatError } from "./lib/format-error";

// Destructive. Drops volumes and re-applies migrations.
async function main(): Promise<void> {
  console.log(kleur.yellow("[db:reset] tearing down stack and volumes"));
  await execa(
    "docker",
    [
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "down",
      "--volumes",
      "--remove-orphans",
    ],
    { stdio: "inherit" },
  );

  console.log(kleur.cyan("[db:reset] starting fresh stack"));
  await execa(
    "docker",
    ["compose", "-f", "docker-compose.dev.yml", "up", "-d"],
    {
      stdio: "inherit",
    },
  );

  console.log(kleur.cyan("[db:reset] waiting 8s for boot"));
  await new Promise((r) => setTimeout(r, 8_000));

  console.log(kleur.cyan("[db:reset] applying migrations"));
  await execa("pnpm", ["db:migrate"], { stdio: "inherit" });

  console.log(kleur.green("[db:reset] done"));
}

main().catch((err) => {
  console.error(kleur.red(formatError(err)));
  process.exit(1);
});
