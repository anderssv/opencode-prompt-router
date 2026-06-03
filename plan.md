# Plan

## Planned Features

- **Directory-level keyword injection**: A config file (e.g. `.opencode/prompt-router.json`) in the launch directory that specifies keywords to always inject into scoring. This would let projects permanently bias toward relevant skills without relying on session accumulation or prompt content alone.

- **Cooldown between injections**: If we inject skill load directives on every turn we crowd the session context. Add a cooldown mechanism — count messages (or context growth) since the last injection and suppress further injections until the cooldown expires. Avoids repeatedly loading the same skill when the conversation stays on-topic.

## Ideas for Context Reinforcement

Beyond skill loading, the plugin can reinforce project/session context in other ways:

- **Project convention reminders**: Extract short directives from AGENTS.md or a config file and inject them as one-liners when token overlap with the prompt is detected. E.g. "Always use TDD in this project", "Prefer fakes over mocks". Lighter than a full skill load.

- **Anti-pattern warnings**: Detect risky patterns in prompts and inject corrective nudges. E.g. if someone says "mock the database", inject "This project uses fakes/nullables instead of mocks — see nullables skill."

- **File-extension context**: Track file types discussed in the session (`.kt`, `.tf`, etc.) and inject relevant convention reminders based on extension → directive mapping, independent of prompt text scoring.

- **Two-tier injection (hint vs. load)**: High confidence (score > 20) loads the full skill. Medium confidence (score 10–15) injects a one-line hint without forcing a skill load, e.g. "Consider loading the `hexagonal-architecture` skill if this involves ports/adapters."

- **Escalation on repeated ignoring**: Track when injected directives are ignored (user corrects or re-asks). Escalate injection strength on subsequent messages — hint → directive → skill load.

- **Always-inject directives**: A simple config file (e.g. `.opencode/directives.md`) with lines unconditionally prepended to every message. Pure reinforcement, zero scoring, no false-positive risk. Repeating key points in user message is stronger than system prompt alone.

## Observations from Log Analysis (2026-06-03)

- **`agent` token causes FP**: The word "agent" appears in AGENTS.md filenames/content across all projects, gets pinned permanently via seeding, then triggers `launching-agent-teams` when user mentions "AGENTS.md". Should add `agent` to suppressors — it's infrastructure vocabulary, not a skill signal.

- **AGENTS.md seeding picks up filename-derived tokens**: When AGENTS.md content mentions "agents" (referring to the file/concept of agent configuration), it seeds a token that then matches skill names containing "agent". Consider filtering tokens that derive from the AGENTS.md filename itself, or treating seeded tokens differently from prompt tokens (e.g. seeded tokens only contribute to session bonus, never to stage1 scoring).

- **Norwegian/non-English prompts**: The English stemmer mangles Norwegian words (e.g. "befaring" → "befar", "nøyaktig" → "yaktig", "røttene" → "ttene"). Not currently causing FPs since mangled stems don't match skill tokens, but worth noting for future i18n support.

- **Near-misses are mostly session-bonus-only**: Many near-miss entries show skills with stage1=0 and only a +5 session bonus. These are useful for debugging session affinity behavior but not for evaluating scoring quality. Consider tagging them differently in analysis (not in logging — keep full detail for debugging).
