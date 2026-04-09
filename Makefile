.PHONY: test lint check-execsync install-hooks

test:
	node --test test/*.test.js

lint: check-execsync
	@echo "✓ Lint passed"

# Check for direct execSync imports (should use utils/exec.js instead)
check-execsync:
	@count=$$(grep -rn 'execSync' --include="*.js" . | grep -v node_modules | grep -v '^./utils/exec.js' | grep -v '.test.js$$' | wc -l); \
	if [ "$$count" -gt 0 ]; then \
		echo "ERROR: Found direct execSync imports (use utils/exec.js instead):"; \
		grep -rn 'execSync' --include="*.js" . | grep -v node_modules | grep -v '^./utils/exec.js' | grep -v '.test.js$$'; \
		exit 1; \
	fi
	@echo "✓ No direct execSync imports found"

install-hooks:
	@mkdir -p .git/hooks
	@echo '#!/bin/sh\nmake check-execsync' > .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✓ Pre-commit hook installed"