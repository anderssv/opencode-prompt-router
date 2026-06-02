# Plan

## Planned Features

- **Directory-level keyword injection**: A config file (e.g. `.opencode/prompt-router.json`) in the launch directory that specifies keywords to always inject into scoring. This would let projects permanently bias toward relevant skills without relying on session accumulation or prompt content alone.

- **Cooldown between injections**: If we inject skill load directives on every turn we crowd the session context. Add a cooldown mechanism — count messages (or context growth) since the last injection and suppress further injections until the cooldown expires. Avoids repeatedly loading the same skill when the conversation stays on-topic.
