Unit Test Rules

 Rule: Record golden-master API responses as fixtures and use them to simulate both ideal generations and error edge-cases.
 Rule: Define explicit TypeScript types for your expected LLM responses.
 Rule: Validate the output shape strictly in your beforeAll / beforeEach setup to prevent type-casting issues.
 Rule: Mock the LLM's network requests using libraries like MSW (Mock Service Worker) or fetch-mock.
 Rule: Never use expect(output).toBe("The answer is 42.").
 Rule: Use semantic or programmatic assertions. Instead of strict equality, assert boolean flags, check for specific key terms, or validate JSON keys:
 ```typescript
expect(response.sentiment).toBe("positive");
expect(response.extractedKeywords).toContain("typescript");
 ```
 Rule: Going forward: if you need to mock drizzle-orm at all, the pattern is:
 ```typescript
vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { ...orig, specificFn: mySpyFn };  // spread all, override only what you spy on
});
```
Rule: Store test cases (inputs and expected outputs) in external JSON files. Iterate through them programmatically using test.each (available in test runners like Jest or Vitest).