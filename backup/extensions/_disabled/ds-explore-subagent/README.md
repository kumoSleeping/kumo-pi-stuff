# DS Explore Subagent

A low-cost advisory reconnaissance extension backed by `deepseek/deepseek-v4-flash`.

```text
ds_explore_subagent({ task, mode, scope, thinking, cwd? })
```

- Use it liberally for broad discovery, independent search fronts, and inspiration
- Treat every result as a lead, not accepted evidence
- The parent agent must personally reopen and verify critical files, URLs, claims, and version boundaries before acting
- `mode`: `shallow` for bounded reconnaissance; `deep` for broad tracing and synthesis
- `scope`: `local`, `web`, or `both`
- `thinking`: relative `low`, `medium`, or `high` tier, mapped to DS Flash's lowest, middle, or highest canonical level
- Child process: ephemeral (`--no-session`) and skill-isolated, while normal extensions remain available for web and other tools
- Output: capped at 2000 lines or 50KB

The child has no parent-conversation context. Every task must include its own background, boundaries, constraints, and requested evidence.
