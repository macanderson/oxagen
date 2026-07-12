#!/usr/bin/env bash
#
# Quick Harbor benchmark runner - 10 random SWE-bench tasks
#
# Usage:
#   ./run-10-random.sh                          # Stella with GLM (default)
#   ./run-10-random.sh --agent oxagen           # Oxagen with Claude
#   ./run-10-random.sh --agent stella --compare # Run both agents
#   ./run-10-random.sh --tasks 5                # Run 5 tasks instead of 10
#   ./run-10-random.sh --budget 10              # $10 per task budget
#   ./run-10-random.sh --concurrent 2           # Run 2 tasks in parallel
#
# Environment variables:
#   AI_GATEWAY_API_KEY=...          # Required for Oxagen
#   ZAI_API_KEY=...                 # Required for Stella GLM
#   ANTHROPIC_API_KEY=...           # Alternative for either agent
#   STELLA_BINARY=...               # Path to Stella binary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default configuration
AGENT="${AGENT:-stella}"
NUM_TASKS="${NUM_TASKS:-10}"
BUDGET="${BUDGET:-10}"
N_CONCURRENT="${N_CONCURRENT:-2}"
COMPARE_WITH_CLAUDE="${COMPARE_WITH_CLAUDE:-false}"
DATASET="${DATASET:-swe-bench/swe-bench-verified}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_header() {
    echo ""
    echo -e "${BOLD}${CYAN}=== $1 ===${NC}"
    echo ""
}

# Show usage
show_usage() {
    cat <<EOF
${BOLD}Quick Harbor Benchmark Runner - Random SWE-bench Tasks${NC}

Usage: $0 [OPTIONS]

Options:
  --agent <name>         Agent to run: stella, oxagen, or claude-code (default: stella)
  --compare              Run both stella and oxagen on the same tasks (for comparison)
  --tasks <n>            Number of random tasks (default: 10)
  --budget <usd>         Per-task budget cap (default: 10)
  --concurrent <n>       Parallel tasks (default: 2)
  --dataset <slug>       Harbor dataset (default: swe-bench/swe-bench-verified)
  --concurrent <n>       Run n tasks in parallel (default: 2)
  --help                 Show this help

Environment:
  AI_GATEWAY_API_KEY=...      Required for Oxagen
  ZAI_API_KEY=...             Required for Stella GLM
  ANTHROPIC_API_KEY=...       Alternative for either agent
  STELLA_BINARY=...           Path to Stella binary (auto-built if unset)

Examples:
  # Run 10 random tasks with Stella GLM
  $0

  # Run 5 tasks with Oxagen Claude Sonnet 5
  $0 --agent oxagen --tasks 5

  # Compare Stella vs Oxagen on same tasks
  $0 --compare --tasks 5 --concurrent 1

  # Run with higher budget and parallelism
  $0 --budget 15 --concurrent 4

EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --agent)
            AGENT="$2"
            shift 2
            ;;
        --compare|--compare-with-claude)
            COMPARE_WITH_CLAUDE=true
            shift
            ;;
        --tasks)
            NUM_TASKS="$2"
            shift 2
            ;;
        --budget)
            BUDGET="$2"
            shift 2
            ;;
        --concurrent)
            N_CONCURRENT="$2"
            shift 2
            ;;
        --dataset)
            DATASET="$2"
            shift 2
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Validate arguments
if [ "$AGENT" != "stella" ] && [ "$AGENT" != "oxagen" ] && [ "$AGENT" != "claude-code" ]; then
    log_error "Invalid agent: $AGENT (must be stella, oxagen, or claude-code)"
    exit 1
fi

# Curated list of diverse SWE-bench Verified tasks (spanning repos, difficulty, domains)
# 50 tasks covering different programming languages, frameworks, and bug types
TASK_POOL=(
    "django__django-11099" "django__django-11051" "django__django-11124"
    "sympy__sympy-23813" "sympy__sympy-18174" "sympy__sympy-14655"
    "matplotlib__matplotlib-22911" "matplotlib__matplotlib-23314" "matplotlib__matplotlib-22892"
    "astropy__astropy-12907" "astropy__astropy-6876" "astropy__astropy-7116"
    "pallets__flask-2996" "pallets__flask-4035" "pallets__flask-4816"
    "mwaskom__seaborn-3069" "mwaskom__seaborn-3245" "mwaskom__seaborn-3197"
    "pylint-dev__pylint-7808" "pylint-dev__pylint-8123" "pylint-dev__pylint-7871"
    "pytest-dev__pytest-5631" "pytest-dev__pytest-5930" "pytest-dev__pytest-5789"
    "scikit-learn__scikit-learn-14085" "scikit-learn__scikit-learn-14487" "scikit-learn__scikit-learn-13454"
    "pandas-dev__pandas-40576" "pandas-dev__pandas-39823" "pandas-dev__pandas-40338"
    "numpy__numpy-21010" "numpy__numpy-21145" "numpy__numpy-20895"
    "psf__requests-4534" "psf__requests-4872" "psf__requests-4697"
    "django__django-12497" "sympy__sympy-21011" "matplotlib__matplotlib-25290"
    "astropy__astropy-13978" "pallets__flask-5233" "mwaskom__seaborn-3416"
    "pylint-dev__pylint-8535" "pytest-dev__pytest-6090" "scikit-learn__scikit-learn-14834"
    "pandas-dev__pandas-41292" "numpy__numpy-21569" "psf__requests-5014"
    "django__django-12692" "sympy__sympy-21329" "matplotlib__matplotlib-25629"
)

# Select N random tasks
select_random_tasks() {
    local count=$1
    local pool_size=${#TASK_POOL[@]}
    local selected=()

    # Use awk for random selection (more portable than $RANDOM)
    selected=$(printf "%s\n" "${TASK_POOL[@]}" | awk -v count="$count" -v seed="$RANDOM" '
        BEGIN {
            srand(seed)
            for (i = 1; i <= count; i++) {
                line = int(rand() * NR) + 1
                if (line in seen) {
                    i--
                    continue
                }
                seen[line]
                print lines[line]
            }
        }
        {
            lines[NR] = $0
        }
    ')

    echo "$selected"
}

SELECTED_TASKS=$(select_random_tasks "$NUM_TASKS")
TASK_COUNT=$(echo "$SELECTED_TASKS" | wc -l | awk '{print $1}')

log_header "Quick Harbor Benchmark - $TASK_COUNT Random Tasks"
log_info "Agent(s): $AGENT $( [ "$COMPARE_WITH_CLAUDE" = true ] && echo '+ oxagen (comparison)' )"
log_info "Dataset: $DATASET"
log_info "Budget: \$$BUDGET per task"
log_info "Concurrent: $N_CONCURRENT"
log_info "Tasks:"
echo "$SELECTED_TASKS" | while read -r task; do
    echo "  - $task"
done
echo ""

# Function to run Oxagen
run_oxagen() {
    log_header "Running Oxagen CLI..."

    # Check for API key
    if [ -z "${AI_GATEWAY_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        log_error "AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY not set"
        return 1
    fi

    cd "$REPO_ROOT/bench/swe-bench"

    # Build Oxagen bundle if needed
    if [ ! -f "$REPO_ROOT/apps/cli/dist-standalone/oxagen.mjs" ]; then
        log_info "Building Oxagen bundle..."
        ( cd "$REPO_ROOT" && pnpm --filter @oxagen/cli bundle )
    fi

    OXAGEN_CLI_BUDGET="$BUDGET" \
    OXAGEN_MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-5}" \
    TASK_IDS="$SELECTED_TASKS" \
    N_CONCURRENT="$N_CONCURRENT" \
    DATASET="$DATASET" \
    ./run.sh
}

# Function to run Stella
run_stella() {
    log_header "Running Stella CLI..."

    # Check for API key
    if [ -z "${ZAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        log_error "ZAI_API_KEY or ANTHROPIC_API_KEY not set for Stella"
        return 1
    fi

    # Set up Stella environment
    export STELLA_BASE_URL="${STELLA_BASE_URL:-https://api.z.ai/api/coding/paas/v4}"
    export STELLA_MODEL="${STELLA_MODEL:-zai/glm-5.2}"

    # Build Stella if needed
    if [ -n "${STELLA_BINARY:-}" ]; then
        STELLA_BIN="$STELLA_BINARY"
    else
        STELLA_BIN="$HOME/Workspaces/stella-cli/target/release/stella"
        if [ ! -f "$STELLA_BIN" ]; then
            log_info "Building Stella..."
            cd "$HOME/Workspaces/stella-cli"
            cargo build --release -p stella-cli
            cd "$SCRIPT_DIR"
        fi
    fi

    export STELLA_BINARY="$STELLA_BIN"
    export STELLA_BUDGET="$BUDGET"

    cd "$REPO_ROOT/bench/swe-bench"

    AGENT=stella \
    TASK_IDS="$SELECTED_TASKS" \
    N_CONCURRENT="$N_CONCURRENT" \
    DATASET="$DATASET" \
    ./run.sh
}

# Run based on agent selection
if [ "$COMPARE_WITH_CLAUDE" = true ]; then
    # Run both agents sequentially on the same tasks
    AGENT=stella run_stella
    echo ""
    AGENT=oxagen run_oxagen
else
    case "$AGENT" in
        oxagen)
            run_oxagen
            ;;
        stella)
            run_stella
            ;;
        claude-code)
            log_error "claude-code is a Harbor built-in agent - run from bench/swe-bench/run.sh directly"
            cd "$REPO_ROOT/bench/swe-bench"
            AGENT=claude-code TASK_IDS="$SELECTED_TASKS" N_CONCURRENT="$N_CONCURRENT" ./run.sh
            ;;
    esac
fi

log_header "Benchmark Complete!"
log_info "Results saved in: bench/swe-bench/results-$AGENT/"
