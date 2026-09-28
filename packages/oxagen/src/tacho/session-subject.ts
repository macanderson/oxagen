/**
 * Session names and summary clipping, defined once in the leaf package. The
 * app reaches them here, the way it reaches the other Tacho shapes.
 */
export {
  SESSION_SUBJECT_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_SENTENCES,
  capSubject,
  clipSummary,
  sessionSubject,
} from "@oxagen/tacho/session-subject";
