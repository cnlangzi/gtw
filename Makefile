.PHONY: test lint check-execsync install-hooks

test:
	@echo "Running unit tests..."
	@node --test \
		utils/git.test.js \
		utils/git.checkout.test.js \
		utils/labels.test.js \
		commands/WatchCommand.test.js \
		commands/ReviewCommand.test.js
	@echo "Running E2E tests..."
	@GTW_CONFIG_DIR=/tmp/gtw-test node --test commands/e2e/workflow.test.js

lint: check-execsync
	@echo "✓ Lint passed"

# Check for direct execSync imports (should use utils/exec.js instead)
check-execsync:
	@count=$$(grep -rn 'execSync' --include="*.js" . | grep -v node_modules | grep -v '^./utils/exec.js' | wc -l); \
	if [ "$$count" -gt 0 ]; then \
		echo "ERROR: Found direct execSync imports (use utils/exec.js instead):"; \
		grep -rn 'execSync' --include="*.js" . | grep -v node_modules | grep -v '^./utils/exec.js'; \
		exit 1; \
	fi
	@echo "✓ No direct execSync imports found"

install-hooks:
	@mkdir -p .git/hooks
	@echo '#!/bin/sh\nmake check-execsync test' > .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✓ Pre-commit hook installed (check-execsync + test)"