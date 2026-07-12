/**
 * Arena Benchmark Types
 *
 * Core schema for agentic coding benchmark results with full provenance tracking.
 * Every result carries model, agent, run date, git SHA, and reproduce command.
 */

/**
 * Supported agent types
 */
export type AgentType = "oxagen" | "stella" | "claude-code" | "custom";

/**
 * Benchmark task categories
 */
export type TaskCategory =
  | "bug-fix"
  | "feature-implementation"
  | "refactoring"
  | "testing"
  | "documentation"
  | "performance"
  | "security"
  | "integration";

/**
 * Task difficulty levels
 */
export type Difficulty = "beginner" | "intermediate" | "advanced" | "expert";

/**
 * Language / ecosystem
 */
export type Ecosystem =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "cpp"
  | "csharp"
  | "php"
  | "ruby"
  | "multi";

/**
 * Provenance tracking - every result MUST have one of these
 */
export type Provenance =
  | { kind: "measured"; runId: string; runDate: string; gitSha: string }
  | { kind: "reference"; source: string; url: string; date: string }
  | { kind: "sample"; notes: string };

/**
 * A single benchmark task
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Task category */
  category: TaskCategory;
  /** Difficulty level */
  difficulty: Difficulty;
  /** Primary ecosystem/language */
  ecosystem: Ecosystem;
  /** Estimated tokens required */
  estimatedTokens: number;
  /** Estimated cost in USD */
  estimatedCost: number;
  /** Source repository (if applicable) */
  sourceRepo?: {
    owner: string;
    name: string;
    commit: string;
  };
  /** Task description / prompt */
  description: string;
  /** Expected success criteria */
  acceptanceCriteria: string[];
  /** Starting point (base commit or description) */
  startingPoint: string;
  /** Files to modify (patterns) */
  filesToModify?: string[];
  /** Test command(s) to verify */
  testCommands?: string[];
  /** Tags for filtering */
  tags: string[];
}

/**
 * Agent configuration for a run
 */
export interface AgentConfig {
  /** Agent type */
  type: AgentType;
  /** Model identifier (e.g., anthropic/claude-sonnet-5) */
  model: string;
  /** Agent-specific configuration */
  config?: Record<string, unknown>;
  /** Budget limit in USD */
  budget?: number;
  /** Timeout in seconds */
  timeout?: number;
}

/**
 * Metrics collected during a run
 */
export interface Metrics {
  /** Success/failure */
  success: boolean;
  /** Pass/fail on acceptance criteria */
  criteriaPassed: string[];
  criteriaFailed: string[];
  /** Total duration in seconds */
  durationSeconds: number;
  /** Total tokens used */
  totalTokens: number;
  /** Input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cache read tokens */
  cacheReadTokens?: number;
  /** Total cost in USD */
  totalCost: number;
  /** Number of tool calls */
  toolCalls: number;
  /** Number of files touched */
  filesTouched: number;
  /** Lines added */
  linesAdded: number;
  /** Lines removed */
  linesRemoved: number;
  /** Git diff size (bytes) */
  diffSize: number;
  /** Number of retry/loop iterations */
  iterations: number;
  /** Peak memory usage (MB) */
  peakMemoryMb?: number;
}

/**
 * A single benchmark result
 */
export interface BenchmarkResult {
  /** Unique result identifier */
  id: string;
  /** Task reference */
  taskId: string;
  /** Agent configuration used */
  agent: AgentConfig;
  /** Metrics collected */
  metrics: Metrics;
  /** Provenance tracking */
  provenance: Provenance;
  /** Verbatim prompt sent to agent */
  prompt: string;
  /** Git diff of changes */
  diff: string;
  /** Agent output / explanation */
  output: string;
  /** Error message (if failed) */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregated results for a task + agent combination
 */
export interface TaskAgentSummary {
  /** Task ID */
  taskId: string;
  /** Agent type */
  agentType: AgentType;
  /** Model used */
  model: string;
  /** Number of runs */
  runCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average duration (seconds) */
  avgDuration: number;
  /** Average cost (USD) */
  avgCost: number;
  /** Average tokens */
  avgTokens: number;
  /** Latest run date */
  latestRun: string;
}

/**
 * Progress tracking entry
 */
export interface TrackerEntry {
  /** Entry date */
  date: string;
  /** Agent type */
  agentType: AgentType;
  /** Model version */
  model: string;
  /** Overall success rate */
  successRate: number;
  /** Average cost per task */
  avgCost: number;
  /** Average duration per task */
  avgDuration: number;
  /** Number of tasks completed */
  tasksCompleted: number;
  /** Notable changes / notes */
  notes?: string;
}

/**
 * Report metadata
 */
export interface ReportMetadata {
  /** Report ID */
  id: string;
  /** Report title */
  title: string;
  /** Generation date */
  generatedAt: string;
  /** Date range of results included */
  dateRange: { start: string; end: string };
  /** Agents compared */
  agents: AgentType[];
  /** Tasks included */
  taskIds: string[];
  /** Filters applied */
  filters?: {
    categories?: TaskCategory[];
    difficulties?: Difficulty[];
    ecosystems?: Ecosystem[];
  };
}

/**
 * Complete benchmark report
 */
export interface BenchmarkReport {
  /** Report metadata */
  metadata: ReportMetadata;
  /** Task-agent summaries */
  summaries: TaskAgentSummary[];
  /** Individual results */
  results: BenchmarkResult[];
  /** Progress tracking history */
  history: TrackerEntry[];
  /** Insights and recommendations */
  insights?: string[];
}
