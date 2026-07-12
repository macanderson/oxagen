/**
 * Arena Task Definitions
 *
 * Curated benchmark tasks for evaluating agentic coding tools.
 * Each task includes full provenance and clear acceptance criteria.
 */

import type { Task } from "../src/lib/types.js";

/**
 * Smoke test tasks — quick validation that agents work
 */
export const smokeTasks: Task[] = [
  {
    id: "smoke-add-import",
    name: "Add Missing Import",
    category: "bug-fix",
    difficulty: "beginner",
    ecosystem: "typescript",
    estimatedTokens: 5000,
    estimatedCost: 0.05,
    description:
      "Add the missing import statement for a utility function that's being used but not imported.",
    acceptanceCriteria: [
      "The correct import statement is added",
      "No other changes are made to the file",
      "The code compiles without errors",
    ],
    startingPoint: "A TypeScript file using 'formatDate' without importing it",
    filesToModify: ["src/utils/date.ts"],
    testCommands: ["tsc --noEmit"],
    tags: ["smoke", "quick", "typescript"],
  },
  {
    id: "smoke-fix-typos",
    name: "Fix Typos in Comments",
    category: "documentation",
    difficulty: "beginner",
    ecosystem: "javascript",
    estimatedTokens: 3000,
    estimatedCost: 0.03,
    description: "Fix typos in JSDoc comments across a small module.",
    acceptanceCriteria: [
      "All documented typos are fixed",
      "No code logic is changed",
      "Comments remain grammatically correct",
    ],
    startingPoint:
      "A JavaScript file with several JSDoc comments containing typos",
    filesToModify: ["src/api/handlers.js"],
    testCommands: ["eslint src/api/handlers.js --max-warnings 0"],
    tags: ["smoke", "quick", "documentation"],
  },
  {
    id: "smoke-add-error-handling",
    name: "Add Error Handling",
    category: "bug-fix",
    difficulty: "intermediate",
    ecosystem: "typescript",
    estimatedTokens: 8000,
    estimatedCost: 0.08,
    description:
      "Add proper try-catch error handling around an API call that currently lacks it.",
    acceptanceCriteria: [
      "API call is wrapped in try-catch",
      "Errors are properly logged",
      "Error responses return appropriate status codes",
      "No changes to happy-path logic",
    ],
    startingPoint: "An API endpoint making an unguarded async call",
    filesToModify: ["src/api/users.ts"],
    testCommands: ["vitest run src/api/users.test.ts"],
    tags: ["smoke", "error-handling", "typescript"],
  },
];

/**
 * Real-world bug fixes
 */
export const bugFixTasks: Task[] = [
  {
    id: "bug-django-orm-11099",
    name: "Django ORM Filter Bug",
    category: "bug-fix",
    difficulty: "advanced",
    ecosystem: "python",
    estimatedTokens: 50000,
    estimatedCost: 0.5,
    sourceRepo: {
      owner: "django",
      name: "django",
      commit: "3.2.0",
    },
    description:
      "Fix a Django ORM filter bug where complex Q objects with negation produce incorrect SQL.",
    acceptanceCriteria: [
      "The fix resolves the issue without breaking existing tests",
      "All existing Django ORM tests pass",
      "The generated SQL is correct",
      "No regression in related functionality",
    ],
    startingPoint: "Django 3.2.0 with the reported bug",
    filesToModify: ["django/db/models/sql/compiler.py"],
    testCommands: [
      "python -m pytest tests/fixtures/models/tests.py -v",
      "python -m pytest tests/queries/test_q_combination.py -v",
    ],
    tags: ["django", "orm", "sql", "advanced"],
  },
];

/**
 * Feature implementation tasks
 */
export const featureTasks: Task[] = [
  {
    id: "feature-rate-limiter",
    name: "Implement Rate Limiter",
    category: "feature-implementation",
    difficulty: "intermediate",
    ecosystem: "typescript",
    estimatedTokens: 20000,
    estimatedCost: 0.2,
    description:
      "Implement a token-bucket rate limiter middleware for an Express API.",
    acceptanceCriteria: [
      "Rate limiter uses token bucket algorithm",
      "Configurable rate limit per IP",
      "Returns 429 when limit exceeded",
      "Includes X-RateLimit-* headers",
      "Has unit tests covering edge cases",
    ],
    startingPoint: "An Express API without rate limiting",
    filesToModify: ["src/middleware/rate-limiter.ts", "src/api/index.ts"],
    testCommands: ["vitest run src/middleware/rate-limiter.test.ts"],
    tags: ["express", "middleware", "rate-limiting", "typescript"],
  },
  {
    id: "feature-websocket-chat",
    name: "WebSocket Chat Room",
    category: "feature-implementation",
    difficulty: "intermediate",
    ecosystem: "javascript",
    estimatedTokens: 30000,
    estimatedCost: 0.3,
    description:
      "Add a real-time chat feature using WebSocket with room support.",
    acceptanceCriteria: [
      "Clients can join named rooms",
      "Messages broadcast to room members only",
      "User join/leave events are broadcast",
      "Connection errors are handled gracefully",
      "Has E2E test verifying message flow",
    ],
    startingPoint: "An HTTP-only Express server",
    filesToModify: ["src/websocket/chat.ts", "src/server.ts"],
    testCommands: ["vitest run src/websocket/chat.test.ts"],
    tags: ["websocket", "realtime", "chat", "javascript"],
  },
];

/**
 * Refactoring tasks
 */
export const refactorTasks: Task[] = [
  {
    id: "refactor-extract-function",
    name: "Extract Complex Function",
    category: "refactoring",
    difficulty: "intermediate",
    ecosystem: "typescript",
    estimatedTokens: 15000,
    estimatedCost: 0.15,
    description:
      "Extract a complex 50-line function into smaller, testable units.",
    acceptanceCriteria: [
      "Function is decomposed into logical units",
      "Each helper function is pure where possible",
      "All existing tests still pass",
      "New tests cover the extracted functions",
    ],
    startingPoint: "A large processing function with mixed concerns",
    filesToModify: ["src/processing/pipeline.ts"],
    testCommands: ["vitest run src/processing/pipeline.test.ts"],
    tags: ["refactoring", "clean-code", "typescript"],
  },
];

/**
 * Testing tasks
 */
export const testTasks: Task[] = [
  {
    id: "test-add-unit-tests",
    name: "Add Unit Tests",
    category: "testing",
    difficulty: "intermediate",
    ecosystem: "typescript",
    estimatedTokens: 20000,
    estimatedCost: 0.2,
    description:
      "Write comprehensive unit tests for an untested utility module.",
    acceptanceCriteria: [
      "All functions in the module have tests",
      "Edge cases are covered",
      "Tests use proper assertions and mocks",
      "Coverage threshold of 90% is met",
    ],
    startingPoint: "A utility module without tests",
    filesToModify: ["src/utils/array.test.ts"],
    testCommands: ["vitest run --coverage src/utils/array.test.ts"],
    tags: ["testing", "vitest", "typescript"],
  },
];

/**
 * All tasks indexed by ID
 */
export const allTasks: Record<string, Task> = [
  ...smokeTasks,
  ...bugFixTasks,
  ...featureTasks,
  ...refactorTasks,
  ...testTasks,
].reduce<Record<string, Task>>(
  (acc, task) => ({ ...acc, [task.id]: task }),
  {},
);

/**
 * Get tasks by category
 */
export function getTasksByCategory(category: string): Task[] {
  return Object.values(allTasks).filter((t) => t.category === category);
}

/**
 * Get tasks by difficulty
 */
export function getTasksByDifficulty(difficulty: string): Task[] {
  return Object.values(allTasks).filter((t) => t.difficulty === difficulty);
}

/**
 * Get tasks by ecosystem
 */
export function getTasksByEcosystem(ecosystem: string): Task[] {
  return Object.values(allTasks).filter((t) => t.ecosystem === ecosystem);
}

/**
 * Get tasks by tag
 */
export function getTasksByTag(tag: string): Task[] {
  return Object.values(allTasks).filter((t) => t.tags.includes(tag));
}

/**
 * Smoke test task IDs
 */
export const SMOKE_TASK_IDS = smokeTasks.map((t) => t.id);
