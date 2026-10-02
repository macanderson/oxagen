// markdown-import: parse_markdown_import and commit_markdown_import (#4907).
// register.ts loads this module lazily, so importing it builds the handlers
// over the production deps and opens no client until a call needs one.
import { createCommitMarkdownImportHandler } from "./commit";
import { markdownImportDeps } from "./deps";
import { createParseMarkdownImportHandler } from "./parse";

const deps = markdownImportDeps();

export const parseMarkdownImportHandler = createParseMarkdownImportHandler(deps);
export const commitMarkdownImportHandler = createCommitMarkdownImportHandler(deps);
