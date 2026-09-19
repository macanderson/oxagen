# Repository commands

Read the [root package.json](../../package.json) for the available commands and their exact implementations. Run a package-local command through its workspace name:

```sh
pnpm --filter @oxagen/<package> <script>
```

Use the [root README](../../README.md) for setup and [CONTRIBUTING.md](../../CONTRIBUTING.md) for verification and delivery. CI runs builds, lint, typechecks, and test suites. The local exception is one test file for code changed by the task:

```sh
pnpm --filter @oxagen/<package> test:unit <file>.test.ts
```

Do not insert `--` before the test filename. For database operations, follow [store migrations](../ops/store-migrations.md) and verify the target environment before making a mutation.
