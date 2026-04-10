.PHONY: test lint scan install-hooks

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

lint: scan
	@echo "✓ Lint passed"

# Run the local dangerous-code scanner (mirrors OpenClaw's skill-scanner rules)
scan:
	@node scripts/scan.js
	@echo "✓ No dangerous code patterns found"

# Install pre-commit hook to run scanner before each commit
install-hooks:
	@mkdir -p .git/hooks
	@echo '#!/bin/sh\nmake scan' > .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✓ Pre-commit hook installed (make scan)"
