// Registers @testing-library/jest-dom matchers on Vitest's `expect`. Matcher
// registration is DOM-free, so it is safe in the default `node` environment and
// in files that opt into `// @vitest-environment jsdom`.
import "@testing-library/jest-dom/vitest";
