// Registers @testing-library/jest-dom matchers on Vitest's `expect`. Matcher
// registration is DOM-free, so it is safe in the default `node` environment and
// in files that opt into `// @vitest-environment jsdom`.
import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

// findBy* and waitFor give up after 1,000 ms by default. Under the coverage
// run's load, UI drawn after an awaited call and a transition can take longer,
// and the test fails at random (#4440). A query that finds its element still
// returns at once. Setting the timeout needs no DOM, so this stays safe in
// `node` files too.
configure({ asyncUtilTimeout: 5_000 });
