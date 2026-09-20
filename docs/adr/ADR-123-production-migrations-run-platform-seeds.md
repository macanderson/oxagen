# ADR-123: Production migrations run platform seeds

Status: Accepted

Date: 2026-09-19

Refs #3405.

## Context

The production migration runner applied Atlas migrations without calling `seedPlatform()`. Local migration runs seeded the Free plan and book editions; production depended on separate manual writes or literal data in an immutable migration.

## Decision

Package the existing `seedPlatform()` entry as a Node executable with its seed assets. The apply path uploads that artifact with the Atlas directory and runs it after a successful migration, using the same database credential and the platform's pinned Node container image. The app node already runs Docker. It needs no source checkout, package manager, or Node installation.

The dry-run script contains no seed command. Failed migrations prevent seeds. Failed seeds fail the command and can be retried because platform seeds are idempotent. Credentials pass to Docker by environment variable name and are never expanded into traced command arguments. Development fixtures are excluded from the invoked entry; paid plan identifiers remain owned by the Stripe synchronization path.

The source remains `seedPlatform()`, so future platform seed calls join the production path. Seed assets are packaged beside the executable in the layout used by the source. Historical migration contents remain immutable.

## Verification

The RDS compatibility job builds the same artifact, applies the migration directory as its Aurora-like non-superuser role, and runs the seed twice. It requires exactly one Free plan and both book editions. The existing remote-script test checks that dry runs cannot seed and apply runs pass the credential by name.

Production readback of the Free plan and book editions is still required before closing #3405. This PR does not apply production migrations or seeds.
