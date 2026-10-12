#!/usr/bin/env bash
# 重新应用 pi-compact-tools 的两处颜色补丁
# （pi update --extensions 升级该包后需重新运行；补丁只影响这两处，版本变化时自动跳过）
#   1. Explored 组的 Read/List/Search 动词 -> #5092D4
#   2. 成功状态的 • 圆点 -> #1BA66D（强绿）
set -euo pipefail
DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-compact-tools/extensions"
python3 - "$DIR" << 'PYEOF'
import sys, os
d = sys.argv[1]
def patch(path, old, new):
    p = os.path.join(d, path)
    if not os.path.exists(p):
        print(f'{path}: 文件不存在（pi-compact-tools 未安装？跳过）'); return
    s = open(p).read()
    if new in s:
        print(f'{path}: 已打过补丁'); return
    if s.count(old) != 1:
        print(f'{path}: 未找到目标（版本可能已变，跳过）'); return
    open(p, 'w').write(s.replace(old, new))
    print(f'{path}: 已应用')
patch('compact-tools-grouping.ts',
    'details.push((index === 0 ? theme.fg("accent", verb) : " ".repeat(verb.length)) + paintSegments(row, theme));',
    'details.push((index === 0 ? "\\x1b[38;2;80;146;212m" + verb + "\\x1b[39m" : " ".repeat(verb.length)) + paintSegments(row, theme));')
patch('compact-tools-codex-rows.ts',
    'const bullet = phase === "success" ? theme.bold(theme.fg("success", CODEX_BULLET))',
    'const bullet = phase === "success" ? theme.bold("\\x1b[38;2;27;166;109m" + CODEX_BULLET + "\\x1b[39m")')
PYEOF
