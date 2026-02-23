# Use Case: Explain Codebase

Generate a structured architecture walkthrough for onboarding or knowledge transfer.

## Input
- Target project path
- Focus area (optional): specific module, layer, or feature to explain

## Output
- Structured architecture explanation with diagrams and navigation pointers

## Preconditions
- Follow `usecases/load-portfolio-context.md` with depth **standard** (fallback: run scout as first step)

## Agent(s)
- **scout** (haiku) — stack detection if no portfolio context
- **documenter** (sonnet) — structured explanation generation

## Steps

1. Load portfolio context for stack summary and project structure
2. If no portfolio entry exists, run scout to detect the stack
3. Documenter reads the project structure, key entry points, and configuration
4. Documenter produces structured walkthrough:
   - System overview with architecture diagram (Mermaid)
   - Technology stack summary
   - Directory structure with purpose of each key directory
   - Data flow description
   - Key entry points and how to navigate the codebase
   - If focus area specified: deep-dive into that area
5. Output the explanation (do not write files unless user requests it)

## Post-conditions
- Explanation references actual file paths in the project
- Diagrams use Mermaid syntax
- Output is presented to user, not written to files by default
