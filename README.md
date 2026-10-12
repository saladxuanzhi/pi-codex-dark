# pi-codex-dark

Codex 风格的 [pi](https://github.com/earendil-works/pi-coding-agent) 定制包：自定义主题 + 彩色 footer + AI 会话标题 + vim 导航 + 右键粘贴。

![style](https://img.shields.io/badge/pi-package-blue)

## 效果

- **codex-dark 主题**：ChatGPT 暗色调色板；工具行指令蓝（`sudo`/`cd` → `#84B4FA`）、参数淡雅红（`-p` → `#EBA0AC`）、绿色统一淡绿 `#AFD7AF`
- **Codex 风格 footer**：第一行 `模型(浅橙) · 目录(浅绿) (分支) · thinking级别 · 会话标题(淡红)`，第二行用量统计与扩展状态（token 速度等）同行右对齐
- **AI 会话标题**：首轮对话后由模型自动总结生成会话标题（针对 openai-completions 网关的推理模型做了 token 优化）
- **jk-select**：所有选项列表支持 vim 风格 `j`/`k` 上下移动
- **right-click-paste**：Linux/WSL/macOS 下鼠标右键粘贴剪贴板

## 安装

```bash
pi install git:github.com/YOUR_USERNAME/pi-codex-dark
```

然后在 `~/.pi/agent/settings.json` 里启用主题（或在 pi 里 `/theme` 选择 `codex-dark`）：

```json
{ "theme": "codex-dark" }
```

重启 pi 生效。

## 兼容性

| 包 | 兼容方式 |
|---|---|
| `git:github.com/elpaca/pi-my-pi` | footer 会读取其 token-speed 状态（`I/F/T/O/TPS`），合并显示在统计行右侧 |
| `npm:pi-compact-tools` | codex-dark 主题直接驱动其配色；`style: "codex"` 时观感与 Codex CLI 一致 |
| `npm:pi-task-title` | **不要同时安装** —— 本包内置 task-title 已包含其全部功能 |

## 可选：pi-compact-tools 两处颜色微调

本主题下 compact-tools 的 Explored 动词与成功圆点默认走主题色；若想要
`Read/List/Search` 动词深蓝 `#5092D4`、成功圆点强绿 `#1BA66D`，运行：

```bash
bash patches/reapply-compact-tools-colors.sh
```

（直接补丁 npm 包，`pi update --extensions` 升级后需重跑；脚本幂等，版本变化时自动跳过。）

## 可选：jk-select 的 vim 键位

`~/.pi/agent/keybindings.json` 加入：

```json
{
  "tui.select.up": ["up", "k"],
  "tui.select.down": ["down", "j"]
}
```

## 会话标题生成的要求

- 需要 `ctx.model` 可用（当前会话模型）
- **openai-completions 网关背后的推理模型**（如火山方舟 ark 路由到 glm/deepseek）：请在 models.json 的模型定义里加 `"reasoning": true`，否则 64 token 的标题请求会被推理耗尽，标题退回首句原文。本包已强制发送 `reasoning_effort: "minimal"` 规避

## 组件说明

| 文件 | 说明 |
|---|---|
| `themes/codex-dark.json` | 完整主题（基于 pi 主题 schema） |
| `extensions/codex-footer.ts` | 通过 `ctx.ui.setFooter()` 接管内置 footer，更新 pi 无需重装 |
| `extensions/task-title.ts` | 基于 pi-task-title v0.1.3，含 openai-completions 推理修复 |
| `extensions/jk-select.ts` | j/k 列表导航 |
| `extensions/right-click-paste.ts` | 右键粘贴 |
| `patches/reapply-compact-tools-colors.sh` | compact-tools 可选颜色补丁 |

## License

MIT
