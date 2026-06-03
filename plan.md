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
