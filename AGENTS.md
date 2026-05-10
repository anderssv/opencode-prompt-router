# AGENTS.md

## Project Overview

OpenCode plugin that automatically routes user prompts to relevant skills using TF-IDF text scoring. When a user sends a chat message, the router scores all discovered `SKILL.md` files against the prompt and injects a preamble instructing the AI to load the best-matching skills.

**Language:** TypeScript | **Runtime:** Bun | **Platform:** OpenCode plugin (`@opencode-ai/plugin`)

## Architecture

Data pipeline pattern with discrete stages in `core/`:

1. **Discovery** (`discovery.ts`) — finds `SKILL.md` files in known paths
2. **Parsing** (`parser.ts`) — extracts YAML frontmatter (name, description, tags)
3. **Enrichment** (`enrich.ts`) — auto-derives tags for skills lacking them
4. **Corpus indexing** (`corpus.ts`) — builds IDF index across all skills
5. **Scoring** (`scorer.ts`) — two-stage TF-IDF with weighted field matching
6. **Routing** (`router.ts`) — orchestrates pipeline, formats output preamble

Entry point: `index.ts` hooks into `chat.message` events.

## Commands

- **Install:** `bun install`
- **Run all tests:** `bun test`
- **Run single test:** `bun test tests/<file>.test.ts`
- **Debug mode:** `PROMPT_ROUTER_DEBUG=1` (logs to `~/prompt-router.log`)

## Conventions

- Files: lowercase kebab-case, one module per concern
- Types/interfaces: PascalCase (`Skill`, `RouterConfig`, `ScoredSkill`)
- Functions: camelCase (`scoreSkill`, `buildCorpusIndex`)
- Tests mirror module names: `scorer.test.ts` for `scorer.ts`
- Configuration centralized in `config.ts`
- Single external dependency — keep it minimal
- Test fixtures in `tests/fixtures/skills/`, approval snapshots in `tests/approvals/`
