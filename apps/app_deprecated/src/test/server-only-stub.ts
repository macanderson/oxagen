// Test stub for the `server-only` package. In unit tests there is no React
// Server Component boundary, so the real `server-only` module (which throws
// "This module cannot be imported from a Client Component module") must be
// aliased to this no-op so server-only modules can be imported and exercised.
export {};
