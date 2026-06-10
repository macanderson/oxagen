#!/bin/bash

# Create results directory
mkdir -p .test-results

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track results
TOTAL=0
PASSED=0
FAILED=0

# Function to run tests for a package
run_package_tests() {
  local pkg_dir=$1
  local pkg_name=$(basename "$pkg_dir")
  local results_file=".test-results/${pkg_name}.txt"

  # Skip if no package.json
  if [ ! -f "$pkg_dir/package.json" ]; then
    return
  fi

  # Check if package has test:unit, test, or test:coverage script
  if ! grep -qE '"test(:|")' "$pkg_dir/package.json"; then
    return
  fi

  TOTAL=$((TOTAL + 1))

  echo -e "${YELLOW}Testing $pkg_name...${NC}"

  # Run tests using pnpm's filter. Use test:unit as the script name
  # (the --filter approach doesn't use the root turbo command, just the package's script)
  if pnpm --filter "$pkg_name" test:unit > "$results_file" 2>&1; then
    PASSED=$((PASSED + 1))
    echo -e "${GREEN}✓ $pkg_name${NC}"
  else
    FAILED=$((FAILED + 1))
    echo -e "${RED}✗ $pkg_name${NC}"
  fi
}

echo "Running tests in all packages and apps..."
echo ""

# Find and run tests in apps, packages, and tools
for dir in apps/* packages/* tools/*; do
  if [ -d "$dir" ]; then
    run_package_tests "$dir"
  fi
done

echo ""
echo "======================================"
echo "Test Results Summary"
echo "======================================"
echo "Total packages tested: $TOTAL"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo "Results saved to: .test-results/"
echo "======================================"
