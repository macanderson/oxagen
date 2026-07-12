# Arena — Agentic Coding Benchmark Framework

**Arena** is a scientifically rigorous benchmark framework for comparing agentic coding tools (Oxagen, Stella, Claude Code, and others) with full provenance tracking and honest, unbiased evaluation.

## Core Principles

### 1. Scientific Honesty First
- **Every result has provenance** — model, run date, git SHA, reproduce command
- **No cherry-picking** — all runs are logged, failures included
- **Statistical rigor** — confidence intervals, multiple runs, significance testing
- **Reproducible** — every result includes the exact command to reproduce

### 2. Fair Comparison
- **Same tasks, different agents** — head-to-head on identical challenges
- **Transparent methodology** — open source, auditable, no hidden tricks
- **Controlled variables** — same timeouts, budgets, environments
- **No simulator bias** — real agents running real code

### 3. Easy to Use
- **Web dashboard** — configure runs, view results, track progress
- **CLI interface** — scriptable, CI-friendly
- **One-command reproducibility** — `pnpm run:benchmark` with simple flags

## Quick Start

```bash
# Navigate to Arena
cd bench/arena

# Install dependencies
pnpm install

# Run smoke tests (quick validation)
pnpm run:benchmark --task smoke-add-import,smoke-fix-typos --agent oxagen

# Launch web dashboard
pnpm dev
# → http://localhost:3300
```

## Project Structure

```
bench/arena/
├── src/
│   ├── lib/              # Core library (types, validation, aggregation)
│   ├── components/       # React components for dashboard
│   └── app/             # Next.js App Router pages
├── tasks/               # Task definitions (indexed by ID)
├── runners/             # Agent runners (Oxagen, Stella, Claude Code)
├── results/             # Collected benchmark results
├── reports/             # Generated reports (HTML, Markdown, JSON)
├── tracker/             # Progress tracking over time
└── scripts/             # CLI utilities
```

## Usage

### Web Dashboard (Recommended)

1. **Launch**: `pnpm dev` → http://localhost:3300
2. **Configure**:
   - Select agents to compare (Oxagen, Stella, Claude Code)
   - Choose models per agent
   - Pick tasks or categories
   - Set budget, timeout, concurrency
3. **Run**: Click "Start Benchmark" and monitor progress live
4. **Analyze**: View comparison charts, individual results, generate reports

### CLI Interface (with Auto-Build for Stella)

The `./run-bench.sh` wrapper automatically ensures Stella is built from source before running benchmarks:

```bash
# Run with auto-build (builds Stella if needed)
./run-bench.sh --agent stella --task smoke-add-import

# Force rebuild Stella
FORCE_BUILD_STELLA=1 ./run-bench.sh --agent stella

# Custom Stella source path
STELLA_SOURCE=~/other/stella-cli ./run-bench.sh --agent stella

# Direct tsx (bypasses auto-build)
pnpm run:benchmark --agent stella --task smoke-add-import
```

```bash
# List available tasks
pnpm run:benchmark --list

# Run specific tasks
pnpm run:benchmark --task smoke-add-import --agent oxagen

# Compare agents
pnpm run:benchmark --task bug-django-orm-11099 --agent oxagen
pnpm run:benchmark --task bug-django-orm-11099 --agent claude-code

# Filter by category
pnpm run:benchmark --filter category=bug-fix

# Custom model
pnpm run:benchmark --agent oxagen --model anthropic/claude-opus-4.8

# Set budget and timeout
pnpm run:benchmark --budget 50 --timeout 1200
```

### Report Generation

```bash
# Generate HTML report
pnpm report:generate --format html --output reports/latest.html

# Generate comparison report
pnpm report:generate --compare --format html

# Include progress history
pnpm report:generate --history
```

## Task Definition

Tasks are defined in `tasks/index.ts` with full acceptance criteria:

```typescript
{
  id: "smoke-add-import",
  name: "Add Missing Import",
  category: "bug-fix",
  difficulty: "beginner",
  ecosystem: "typescript",
  estimatedTokens: 5000,
  estimatedCost: 0.05,
  description: "Add the missing import statement...",
  acceptanceCriteria: [
    "The correct import statement is added",
    "No other changes are made to the file",
    "The code compiles without errors"
  ],
  testCommands: ["tsc --noEmit"]
}
```

## Provenance Tracking

Every result includes:

```json
{
  "id": "smoke-add-import-oxagen-anthropic/claude-sonnet-5-1234567890",
  "agent": {
    "type": "oxagen",
    "model": "anthropic/claude-sonnet-5"
  },
  "metrics": {
    "success": true,
    "durationSeconds": 12.3,
    "totalTokens": 4521,
    "totalCost": 0.04
  },
  "provenance": {
    "kind": "measured",
    "runId": "run-1234567890-abc123",
    "runDate": "2026-07-11T12:34:56.789Z",
    "gitSha": "a1b2c3d"
  },
  "prompt": "...",
  "diff": "..."
}
```

## Comparison Methodology

### Head-to-Head Runs
- Same task ID
- Same acceptance criteria
- Same timeout/budget
- Same starting conditions
- Multiple runs for statistical significance

### Metrics Tracked
- Success rate (pass/fail acceptance criteria)
- Duration (seconds)
- Cost (USD)
- Tokens used
- Files touched
- Lines added/removed

### Statistical Rigor
- Multiple runs per task-agent pair
- Confidence intervals on success rates
- Paired statistical tests for comparisons
- Effect sizes reported

## Adding New Agents

1. Create runner in `runners/`:
```typescript
export class CustomRunner extends BaseAgentRunner {
  agentType = "custom" as const;
  // Implement required methods
}
```

2. Register in `runners/index.ts`:
```typescript
export const runners: Record<AgentType, () => AgentRunner> = {
  custom: () => new CustomRunner()
};
```

## Environment Variables

```bash
# Oxagen
AI_GATEWAY_API_KEY=sk-...
OXAGEN_MODEL_SLUG=anthropic/claude-sonnet-5

# Stella
ZAI_API_KEY=...
STELLA_BASE_URL=https://api.z.ai/api/coding/paas/v4

# Claude Code
ANTHROPIC_API_KEY=sk-...
CLAUDE_MODEL=claude-sonnet-5
```

## Scripts

```bash
pnpm run:benchmark      # Execute benchmarks
pnpm report:generate    # Generate reports
pnpm tracker:update     # Update progress tracking
pnpm dev                # Launch web dashboard
pnpm build              # Build for production
pnpm typecheck          # Type check
pnpm lint               # Lint
pnpm test:unit          # Run unit tests
```

## License

MIT

## Contributing

Contributions welcome! Please:
1. Add tests for new tasks
2. Document methodology
3. Ensure provenance tracking
4. Run full gate before PR: `pnpm typecheck && pnpm lint && pnpm test:unit`
