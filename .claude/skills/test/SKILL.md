---
name: test
description: Run existing tests, generate missing tests, and report coverage
user_invocable: true
arguments:
  - name: scope
    description: "'run' to execute tests, 'generate' to create missing tests, 'coverage' for coverage report, or file paths"
    required: false
---

# /test

Run and generate tests for the project.

## Steps

1. **Load portfolio context**:
   - Resolve the target project path (from cwd or arguments)
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/<project>/<component>.json` and `portfolio/<org>/organization.json`
   - If not found: fall back to running the **scout** agent (model: haiku) to detect the testing framework inline

2. Based on scope:
   - **run** (default): Execute the project's test suite using detected test runner
   - **generate**: Use the **tester** agent to analyze code and generate missing tests
   - **coverage**: Run tests with coverage reporting enabled
   - **file paths**: Run tests for specific files or generate tests for specific source files

3. For test generation, the **tester** agent (model: sonnet) will:
   - Read source files to understand what needs testing
   - Check existing test patterns in the project
   - Generate tests following project conventions
   - Run the new tests to verify they pass

4. Report results

## Output

- Test execution results (pass/fail counts)
- Coverage report (if requested)
- Generated test files (if generating)
- Recommendations for improving test coverage
