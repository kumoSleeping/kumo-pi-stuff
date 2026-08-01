# kumo-layout

A local Pi extension for a cleaner conversation layout.

- User messages use edge-to-edge gray text with no left/right inset, framed by thin rules that match the active thinking-level color.
- Long user messages wrap cleanly at the full terminal width.
- Collapsed calls render as a compact truncated summary.
- Parallel groups remain visibly running until every tool has emitted `tool_execution_end`, then settle to the group's final success/failure state.
- Running tools show a live elapsed timer; completed tools keep their final duration.
- The summary contains tool names plus useful arguments (commands, paths, or patterns).
- `subagent` and `ds_explore_subagent` use a small grouped block with live activity, elapsed time, model identity, turns, and nested token usage.
- No repeated `Ctrl+O` text.
- Extension dialogs (`ctx.ui.select`/`ctx.ui.input`, e.g. ask-user prompts) recolor their two framing rules to the editor's thinking-level border color, matching the input box they temporarily replace. Pi's own dialogs keep their default chrome.
- Ctrl+K toggles the whole conversation between Kumo layout and Pi's original layout.
- Pi mode restores Pi's own tool framing, expansion state, and user-message rendering.
- The selected layout is restored on the next Pi launch.
- Tool execution is untouched: the extension only changes TUI rendering for selected file, shell, requirements, Jina, and subagent tools.

The compact tool view patches only the exported `ToolExecutionComponent.prototype.render`, `UserMessageComponent.prototype.render`, and the two extension-dialog (`ExtensionSelectorComponent` / `ExtensionInputComponent`) `render` methods. It does not register replacement tools or call built-in tool-definition factories, so execution and overrides supplied by sandbox, SSH, or other extensions remain active. Live grouping is reset at `agent_start` and when a new text/thinking block begins.

## Custom tool adaptations (no source edits)

The built-in adaptation table covers pi's own tools, including tools that jina-2webtools, bash-jobs, requirements-goals and other extensions register under the same names (`parallel_search_web`, `read_url`, `bash`, `bash_job`, `requirements_*`, `computer_use`, ...). For your own plugins' tools, add an entry to the **user-owned** config file instead of editing this source:

```json
// ~/.pi/agent/kumo-layout.config.json
{
  "version": 1,
  "tools": [
    {
      "name": "my_search",
      "label": "My Search",
      "category": "Search",
      "summary": "{{args.query}} · {{args.limit}}"
    },
    {
      "name": "my_agent",
      "label": "My Agent",
      "category": "Agent",
      "agent": true
    },
    {
      "name": "user_input",
      "label": "Ask",
      "category": "Ask",
      "summary": "{{args.question}}",
      "result": "{{details.answer}}"
    },
    {
      "prefix": "search_",
      "label": "Search",
      "category": "Search",
      "summary": "{{args.query}}"
    }
  ]
}
```

- `name` matches one tool exactly; `prefix` adapts every tool whose name starts with it (longest prefix wins). Either is required, `label` is required.
- `summary` is a ` · `-separated template. A segment is kept only when every `{{...}}` inside it resolves, so optional args disappear cleanly. Supported lookups: `{{args.path}}`, `{{count:args.searches}}` (array length), `{{args.searches.0.query}}` (array index).
- `result` is an optional template evaluated against the tool's **result object** once the call settles (same `{{...}}` syntax, rooted at the result: `{{details.answer}}`). When it resolves, the summary appends `→ value`; while the tool is running or when the template cannot resolve (e.g. a cancelled prompt), nothing is shown. Works for live calls and for settled history rebuilt by `/reload`.
- `agent: true` renders the tool as a grouped agent block with live activity, turns, and nested token usage (like `subagent`).
- Without `summary`, only the label (plus duration) is shown. Without a config entry at all, the tool keeps Pi's original rendering.
- Entries with the same `name` as a built-in **override** it (your label/summary/category win).
- Unknown fields are ignored; a corrupt config file falls back to the built-in table and never breaks rendering.

### The `/kumo-layout` command

```
/kumo-layout list
/kumo-layout add <name> --label "My Tool" [--category Search] [--summary "{{args.path}}"] [--result "{{details.answer}}"] [--agent] [--prefix <p>]
/kumo-layout remove <name>
/kumo-layout reset
```

`add`/`remove`/`reset` write the config file atomically and take effect immediately (no `/reload`). `list` shows the merged table with source markers (`built-in`, `override`, `user`, `prefix`) plus `[agent]` and `[→result]` capability flags.

### Upgrade safety

The config file lives in the pi agent directory next to the state file (`~/.pi/agent/`), while the extension code ships in the installed package directory. Package updates (`pi update`, `pi install ...@new-version`, git pulls) only touch the package directory, so **user adaptations survive every plugin update unchanged**; new built-in adaptations arrive with the new package and merge underneath user entries.

## Ctrl+K

Pi normally assigns Ctrl+K to `tui.editor.deleteToLineEnd`. Free the key for this extension in `~/.pi/agent/keybindings.json`:

```json
{
  "tui.editor.deleteToLineEnd": ["alt+k"]
}
```

Run `/reload` after changing the keybindings. Without this remapping, Pi rejects the extension shortcut as a built-in conflict.

## Verification

Run the regression suite from this directory:

```bash
npm test
```

It covers parallel grouping, live/final tool timing and spinner settlement, grouped subagent activity and token progress, `agent_start` group freezing, settled tool history rebuilt by `/reload`, compact/original rendering for `bash_job` and Jina tools, restoration of both expanded and collapsed `toolsExpanded` states, persistence, silent layout switching, theme-sensitive rerendering, extension-dialog rule recoloring (thinking-level color in compact mode, Pi's color in original mode), and the config-driven custom tool adaptations (merge, override, prefix, template resolution, result echoes for live and historical calls, corrupt-config fallback, command writes). The extension is also smoke-tested by launching Pi itself in a pseudo-terminal; `npm run tauri:dev` belongs to the unrelated KDJ desktop project and is not a Pi TUI validation command.
