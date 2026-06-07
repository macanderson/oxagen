// Vitest global setup. Registers @testing-library/jest-dom matchers on `expect`
// (e.g. toBeInTheDocument, toHaveAttribute). Matcher registration is DOM-free,
// so importing here is safe for both the default `node` environment and the
// per-file `// @vitest-environment jsdom` component tests. Component render
// tests must still declare the jsdom docblock at the top of the file.
import "@testing-library/jest-dom/vitest";
