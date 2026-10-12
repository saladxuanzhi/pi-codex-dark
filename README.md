# pi-codex-dark

Codex-style theme and tooling for [pi](https://github.com/earendil-works/pi-coding-agent): a custom theme, colored footer, AI session titles, vim navigation, and right-click paste.

![style](https://img.shields.io/badge/pi-package-blue)

## What you get

- **codex-dark theme**: ChatGPT-dark palette; tool commands in blue (`sudo`/`cd` → `#84B4FA`), parameters in soft red (`-p` → `#EBA0AC`), all greens unified to pale green `#AFD7AF`
- **Codex-style footer**: first line `model(pale orange) · cwd(pale green) (branch) · thinking level · session title(pale red)`; second line merges usage stats with extension statuses (token speed etc.) right-aligned on one line
- **Live token stats**: `↑ ↓ R CH` and context usage update in real time as tool calls complete while streaming
- **AI session titles**: after the first turn, the model summarizes the conversation into a session title (with a token optimization for reasoning models behind openai-completions gateways)
- **jk-select**: vim-style `j`/`k` navigation in every select list
- **right-click-paste**: right-click clipboard paste on Linux/WSL/macOS

## Install

```bash
pi install git:github.com/saladxuanzhi/pi-codex-dark
```

Then enable the theme in `~/.pi/agent/settings.json` (or pick `codex-dark` via `/theme` inside pi):

```json
{ "theme": "codex-dark" }
```

Restart pi to apply.

## Compatibility

| Package | How it works together |
|---|---|
| `git:github.com/elpaca/pi-my-pi` | The footer reads its token-speed status (`I/F/T/O/TPS`) and shows it right-aligned on the stats line |
| `npm:pi-compact-tools` | The codex-dark theme drives its colors directly; with `style: "codex"` it looks like the Codex CLI |
| `npm:pi-task-title` | **Do not install both** — the bundled task-title already includes all of its functionality |

## Optional: two color tweaks for pi-compact-tools

With this theme, compact-tools' Explored verbs and the success dot follow theme colors. If you want the
`Read`/`List`/`Search` verbs in darker blue `#5092D4` and the success dot in vivid green `#1BA66D`, run:

```bash
bash patches/reapply-compact-tools-colors.sh
```

(The script patches the npm package in place. Re-run it after `pi update --extensions`; it is idempotent and skips automatically if the target version changed.)

## Optional: vim keybindings for jk-select

Add to `~/.pi/agent/keybindings.json`:

```json
{
  "tui.select.up": ["up", "k"],
  "tui.select.down": ["down", "j"]
}
```

## Session title requirements

- Requires `ctx.model` to be available (the current session model)
- **Reasoning models behind openai-completions gateways** (e.g. Volcengine Ark routing to glm/deepseek): add `"reasoning": true` to the model definition in models.json, otherwise the 64-token title request gets consumed by reasoning and the title falls back to the raw first prompt. This package already forces `reasoning_effort: "minimal"` to avoid that

## Components

| File | Description |
|---|---|
| `themes/codex-dark.json` | Full theme (based on the pi theme schema) |
| `extensions/codex-footer.ts` | Takes over the built-in footer via `ctx.ui.setFooter()` — survives pi updates without re-patching |
| `extensions/task-title.ts` | Based on pi-task-title v0.1.3, with the openai-completions reasoning fix |
| `extensions/jk-select.ts` | j/k navigation for select lists |
| `extensions/right-click-paste.ts` | Right-click paste |
| `patches/reapply-compact-tools-colors.sh` | Optional color patch for compact-tools |

## License

MIT
