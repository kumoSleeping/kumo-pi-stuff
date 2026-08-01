# Subagent

A general isolated worker extension using the current parent model.

```text
subagent({ task, mode, scope, thinking, cwd? })
```

- Use it for investigation, implementation, testing, verification, or web research
- It may call `ds_explore_subagent` for low-cost reconnaissance, then must verify material DS findings itself
- `mode`: `shallow` for bounded work; `deep` for broad multi-step work
- `scope`: `local`, `web`, or `both`
- `thinking`: relative `low`, `medium`, or `high` tier
- Model: always the current parent model
- Thinking mapping: lowest, middle, or highest supported canonical level; non-reasoning models resolve to `off`
- Child process: ephemeral (`--no-session`) and skill-isolated, while normal extensions remain available
- Recursion prevention: the child suppresses only this extension's own registration
- Output: capped at 2000 lines or 50KB

The child has no parent-conversation context. Include all background, objectives, constraints, expected output, and verification requirements in `task`.
