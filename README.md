# pi-codex-dark

Codex-style theme and tooling for [pi](https://github.com/earendil-works/pi-coding-agent): a custom theme, colored footer, AI session titles, vim navigation, and right-click paste.

![style](https://img.shields.io/badge/pi-package-blue)

## What you get

- **Codex markdown rendering**: Codex CLI's Catppuccin palette for headings, bold/italic, inline code, links, quotes, list markers and fenced code — Mocha on dark terminals, Latte on light ones
- **codex-dark / codex-light themes**: the existing dark UI palette plus a matching light theme; tool commands stay blue (`sudo`/`cd` → `#84B4FA`), parameters soft red (`-p` → `#EBA0AC`), all greens pale green `#AFD7AF`
- **Codex-style footer**: first line `model(pale orange) · cwd(pale green) (branch) · thinking level · session title(catppuccin-mocha accent)`; second line merges usage stats with extension statuses (token speed etc.) right-aligned on one line
- **Catppuccin session title colors**: each new session is assigned one of the 14 Catppuccin Mocha accents (rosewater → lavender) as its title color; the color is stable when a session is resumed and a new session avoids repeating the previous one
- **Live token stats**: `↑ ↓ R CH` and context usage update in real time as tool calls complete while streaming
- **AI session titles**: after the first turn, the model summarizes the conversation into a session title (with a token optimization for reasoning models behind openai-completions gateways)
- **jk-select**: vim-style `j`/`k` navigation in every select list
- **right-click-paste**: right-click clipboard paste on Linux/WSL/macOS

## Install

```bash
pi install git:github.com/saladxuanzhi/pi-codex-dark
```

Then enable the automatic light/dark pair in `~/.pi/agent/settings.json` (or pick it via `/theme` inside pi):

```json
{ "theme": "codex-light/codex-dark" }
```

Pi chooses `codex-light` (Catppuccin Latte) or `codex-dark` (Catppuccin Mocha) from the terminal background. Use `"codex-dark"` or `"codex-light"` alone to force one appearance. Restart pi to apply.

## Markdown colors

The bundled `codex-markdown` extension reproduces Codex's terminal rendering on top of pi's Markdown component. It follows the active theme's appearance, so the automatic `codex-light/codex-dark` pair switches palettes with the terminal. Codex's visible heading markers (`#`, `##`, …) are kept at every heading level.

| Markdown element | Dark (Mocha) | Light (Latte) | Style |
|---|---|---|---|
| Body text and list content | terminal default | terminal default | regular |
| `# H1` | `#F38BA8` | `#D20F39` | bold + underline |
| `## H2` | `#FAB387` | `#FE640B` | bold |
| `### H3` | `#F9E2AF` | `#DF8E1D` | bold + italic |
| `####`–`######` | `#F9E2AF` | `#DF8E1D` | italic (all fall back to the generic heading yellow) |
| `**bold**`, `*italic*` | `#F38BA8` | `#D20F39` | bold / italic |
| Inline code | `#A6E3A1` | `#40A02B` | regular |
| Link text | `#89B4FA` | `#1E66F5` | underline |
| Quote text | `#F5C2E7` | `#EA76CB` | quote style |
| Unordered list bullet | `#94E2D5` | `#179299` | marker only |
| Ordered list number | ANSI LightBlue | ANSI LightBlue | terminal palette decides the exact color |
| `~~strikethrough~~` | inherited | inherited | strikethrough only |
| Code strings / numbers+bools / keywords / functions / comments | `#A6E3A1` / `#FAB387` / `#CBA6F7` / `#89B4FA` / `#9399B2` | `#40A02B` / `#FE640B` / `#8839EF` / `#1E66F5` / `#7C7F93` | fenced blocks with a language tag |

The footer keeps its existing Codex styling. Theme values for `md*` and `syntax*` are also used by HTML exports.

## Session title colors

The footer colors the session title with the palette below. The color is derived from the session id, so it survives
restarts and resumes, and new sessions rotate to a different accent:

| Name | HEX | Name | HEX |
|---|---|---|---|
| Rosewater | `#F5E0DC` | Peach | `#FAB387` |
| Flamingo | `#F2CDCD` | Yellow | `#F9E2AF` |
| Pink | `#F5C2E7` | Green | `#A6E3A1` |
| Mauve | `#CBA6F7` | Teal | `#94E2D5` |
| Red | `#F38BA8` | Sky | `#89DCEB` |
| Maroon | `#EBA0AC` | Sapphire | `#74C7EC` |
| Blue | `#89B4FA` | Lavender | `#B4BEFE` |

## Compatibility

| Package | How it works together |
|---|---|
| `git:github.com/elpaca/pi-my-pi` | The footer reads its token-speed status (`I/F/T/O/TPS`) and shows it right-aligned on the stats line |
| `npm:pi-compact-tools` | The codex-dark/codex-light themes drive its colors directly; with `style: "codex"` it looks like the Codex CLI |
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
| `themes/codex-dark.json` | Dark theme (appearance `dark`, markdown/syntax in Catppuccin Mocha) |
| `themes/codex-light.json` | Light theme (appearance `light`, markdown/syntax in Catppuccin Latte) |
| `extensions/codex-markdown.ts` | Runtime patch for per-level heading colors, colored bold/italic, quote/list marker colors |
| `extensions/codex-footer.ts` | Takes over the built-in footer via `ctx.ui.setFooter()` — survives pi updates without re-patching |
| `extensions/task-title.ts` | Based on pi-task-title v0.1.3, with the openai-completions reasoning fix |
| `extensions/jk-select.ts` | j/k navigation for select lists |
| `extensions/right-click-paste.ts` | Right-click paste |
| `patches/reapply-compact-tools-colors.sh` | Optional color patch for compact-tools |

## License

MIT
