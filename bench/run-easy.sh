#!/usr/bin/env bash
#
# Easy Harbor SWE-bench runner
#
# Quick start:
#   ./run-easy.sh oxagen        # Run Oxagen CLI (smoke test, ~$5-10)
#   ./run-easy.sh stella        # Run Stella CLI (smoke test, ~$5-10)
#   ./run-easy.sh both          # Run both agents
#
# Environment:
#   export AI_GATEWAY_API_KEY=...      # For Oxagen
#   export ZAI_API_KEY=...             # For Stella
#   export ANTHROPIC_API_KEY=...       # Alternative for either
#
# Options:
#   TASK_IDS="..."                     # Specific tasks (default: 3 smoke tasks)
#   BUDGET=25                          # Total USD cap (default: 25)
#   N_CONCURRENT=1                     # Parallel tasks (default: 1 for safety)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default configuration
AGENT="${1:-}"
BUDGET="${BUDGET:-25}"
N_CONCURRENT="${N_CONCURRENT:-1}"
TASK_IDS="${TASK_IDS:-django__django-11099 django__django-11051 sympy__sympy-23813}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Show usage
show_usage() {
    cat <<EOF
Usage: $0 <agent> [options]

Agents:
  oxagen    Run Oxagen CLI benchmark
  stella    Run Stella CLI benchmark
  both      Run both agents sequentially

Environment:
  AI_GATEWAY_API_KEY=...      Required for Oxagen
  ZAI_API_KEY=...             Required for Stella (or use ANTHROPIC_API_KEY)
  ANTHROPIC_API_KEY=...       Alternative for either agent

Options:
  BUDGET=25                   Total USD cap per agent (default: 25)
  N_CONCURRENT=1              Parallel tasks (default: 1)
  TASK_IDS="task1 task2"      Specific tasks (default: 3 smoke tasks)

Examples:
  # Run Oxagen smoke test
  $0 oxagen

  # Run Stella with custom budget
  BUDGET=50 $0 stella

  # Run both with specific tasks
  TASK_IDS="django__django-11099" $0 both
EOF
}

# Validate arguments
if [ -z "$AGENT" ]; then
    log_error "No agent specified"
    show_usage
    exit 1
fi

if [ "$AGENT" != "oxagen" ] && [ "$AGENT" != "stella" ] && [ "$AGENT" != "both" ]; then
    log_error "Invalid agent: $AGENT"
    show_usage
    exit 1
fi

log_info "=== Harbor SWE-bench Easy Runner ==="
log_info "Agent(s): $AGENT"
log_info "Budget: \$$BUDGET per agent"
log_info "Tasks: $TASK_IDS"
log_info "Concurrent: $N_CONCURRENT"
echo ""

# Function to run Oxagen
run_oxagen() {
    log_info "Running Oxagen CLI..."

    # Check for API key
    if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
        log_error "AI_GATEWAY_API_KEY not set"
        log_error "Export: export AI_GATEWAY_API_KEY=..."
        return 1
    fi

    cd "$REPO_ROOT/bench/swe-bench"

    # Calculate per-task budget (rough estimate)
    NUM_TASKS=$(echo "$TASK_IDS" | wc -w | awk '{print $1}')
    PER_TASK_BUDGET=$(echo "scale=2; $BUDGET / $NUM_TASKS" | bc)

    log_info "Per-task budget: \$$PER_TASK_BUDGET"

    AGENT=oxagen \
    OXAGEN_MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-5}" \
    TASK_IDS="$TASK_IDS" \
    N_CONCURRENT="$N_CONCURRENT" \
    OXAGEN_CLI_BUDGET="$PER_TASK_BUDGET" \
    ./run.sh
}

# Function to run Stella
run_stella() {
    log_info "Running Stella CLI..."

    # Check for API key
    if [ -z "${ZAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        log_error "No API key set for Stella"
        log_error "Export: export ZAI_API_KEY=... or export ANTHROPIC_API_KEY=..."
        return 1
    fi

    # Set up Stella environment
    export STELLA_BASE_URL="${STELLA_BASE_URL:-https://api.z.ai/api/coding/paas/v4}"
    export STELLA_MODEL="${STELLA_MODEL:-zai/glm-5.2}"
    export STELLA_BINARY="${STELLA_BINARY:-$HOME/Workspaces/stella-cli/target/release/stella}"

    # Build Stella if needed
    if [ ! -f "$STELLA_BINARY" ]; then
        log_info "Building Stella..."
        cd "$HOME/Workspaces/stella-cli"
        cargo build --release -p stella-cli
    fi

    cd "$HOME/Workspaces/stella-cli/bench/harbor_adapter"

    # Calculate per-task budget
    NUM_TASKS=$(echo "$TASK_IDS" | wc -w | awk '{print $1}')
    PER_TASK_BUDGET=$(echo "scale=2; $BUDGET / $NUM_TASKS" | bc)

    log_info "Per-task budget: \$$PER_TASK_BUDGET"
    log_info "Stella binary: $STELLA_BINARY"
    log_info "Base URL: $STELLA_BASE_URL"

    # Install adapter if needed
    if ! python3 -c "import stella_harbor" 2>/dev/null; then
        log_info "Installing Stella Harbor adapter..."
        python3 -m pip install -e . --break-system-packages --quiet
    fi

    TASK_IDS="$TASK_IDS" \
    N_CONCURRENT="$N_CONCURRENT" \
    STELLA_BUDGET="$PER_TASK_BUDGET" \
    ./run.sh
}

# Run based on agent selection
case "$AGENT" in
    oxagen)
        run_oxagen
        ;;
    stella)
        run_stella
        ;;
    both)
        log_info "Running both agents sequentially..."
        echo ""
        run_oxagen
        echo ""
        run_stella
        ;;
esac

log_info "Done!"
