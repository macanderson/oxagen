/**
 * Shared shapes for the repository contracts: how GitHub names an account and
 * a repository, and the public id of a repository binding.
 *
 * They lived in the `bind_main_repository` contract until #4616 removed that
 * capability (ADR-212). This file registers no capability.
 */
import { z } from "zod";

/** A GitHub account login, as GitHub constrains it. */
export const githubOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);

/** A GitHub repository name, as GitHub constrains it. */
export const githubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);

/** A repository binding's public id: `rpb_` and a hex suffix. */
export const repositoryBindingIdSchema = z.string().regex(/^rpb_[0-9a-f]+$/);
