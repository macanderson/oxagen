/**
 * Shared shapes for working copies: a directory on a machine that `oxagen
 * init` linked to this workspace, and the `.oxagen/` tree it holds.
 *
 * A working copy is reported by the CLI, not discovered. `oxagen init` and
 * `oxagen pull` send what the machine can see about the directory
 * (`record_working_copy`), and the Repositories page lists what was sent
 * (`list_working_copies`). Nothing here reads the working tree: the report
 * carries the git remote, the branch, the head commit and the state of
 * `.oxagen/`, never a file's contents.
 */
import { z } from "zod";

/** `wcp_` plus the public-id suffix `idMixin` mints. */
export const workingCopyIdSchema = z.string().regex(/^wcp_[0-9A-Za-z]+$/);

/** A git commit sha, short or full. */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

/**
 * The state of stella's links into `.oxagen/`: `linked` when every expected
 * symlink resolves, `missing` when one is absent or broken, `none` when the
 * directory has no `.stella/` at all.
 */
export const workingCopySymlinksSchema = z.enum(["linked", "missing", "none"]);

/** The CLI command that sent the report. */
export const workingCopyEventSchema = z.enum(["init", "pull"]);
