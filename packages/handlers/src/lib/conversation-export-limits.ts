export const MAX_EXPORT_MESSAGES = 500;
export const MAX_EXPORT_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_EXPORT_HEADER_BYTES = 8 * 1024;
export const MAX_EXPORT_MARKDOWN_BYTES = 4 * 1024 * 1024;
export const MAX_EXPORT_PDF_TEXT_BYTES = 128 * 1024;
export const MAX_EXPORT_PDF_BLOCKS = 2_000;
export const MAX_EXPORT_PDF_PAGES = 100;

export function exportLimitError(limit: string): Error {
  return new Error(
    `Conversation export exceeds ${limit}. Nothing was exported. Shorten the relevant text or use a smaller conversation. For a PDF limit, try Markdown.`,
  );
}
