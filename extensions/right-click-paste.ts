/**
 * right-click-paste — 在全屏模式下用鼠标右键把剪贴板内容粘贴进输入框。
 *
 * pi 内置了右键粘贴（interactive-mode 的 handleRightClickPaste：读剪贴板 →
 * 以 bracketed paste 形式喂给焦点组件），但 TUI 层的入口
 * TuiAltScreen.handleRightClickPaste 硬编码了 `process.platform === "win32"`，
 * Linux/macOS 上直接跳过。本扩展在 Linux/WSL/macOS 上启用同一行为：
 *
 * - 覆盖 alt-screen 实例的 handleRightClickPaste 钩子（右键 press → 粘贴）；
 * - 剪贴板读取链：termux-clipboard-get → wl-paste → xclip → xsel →
 *   WSL 下 powershell.exe Get-Clipboard → macOS pbpaste / Windows powershell；
 * - 仅当焦点在主编辑器上时粘贴（列表/对话框聚焦时右键不动作）；
 * - 粘贴以 bracketed paste（\x1b[200~...\x1b[201~）形式插入，编辑器按一次
 *   粘贴处理（保留多行、不逐字符触发补全）。
 *
 * 前提：终端把右键事件交给应用（pi 全屏模式已开启鼠标上报；tmux 需 `set -g mouse on`）。
 * 若在支持“右键粘贴”的终端（如 Windows Terminal）里，右键可能被终端自身处理，到不了 pi。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const WIDGET_KEY = "right-click-paste";

interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

type AltScreenTui = TUI & {
  handleRightClickPaste?: (event: SgrMouseEvent) => boolean;
  requestRender?: () => void;
};

// ---------- 剪贴板读取 ----------

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error || typeof stdout !== "string") resolve(null);
          else resolve(stdout);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function isWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
}

/** 读取系统剪贴板文本；失败返回 null。 */
async function readClipboardText(): Promise<string | null> {
  const commands: Array<[string, string[], number]> = [];
  if (process.platform === "linux") {
    if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", [], 1500]);
    if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline"], 1500]);
    if (process.env.DISPLAY) {
      commands.push(["xclip", ["-selection", "clipboard", "-out"], 1500]);
      commands.push(["xsel", ["--clipboard", "--output"], 1500]);
    }
    if (isWSL()) {
      // WSLg 的 X11 剪贴板与 Windows 桥接，但 xclip/wl-paste 往往没装；
      // interop 读取 Windows 剪贴板（-Raw 保留完整文本，显式 UTF-8 防中文乱码）。
      commands.push([
        "powershell.exe",
        ["-NoProfile", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw"],
        5000,
      ]);
    }
  } else if (process.platform === "darwin") {
    commands.push(["pbpaste", [], 1500]);
  } else if (process.platform === "win32") {
    commands.push([
      "powershell.exe",
      ["-NoProfile", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw"],
      5000,
    ]);
  }

  for (const [command, args, timeoutMs] of commands) {
    const out = await runCommand(command, args, timeoutMs);
    if (out !== null) return out;
  }
  return null;
}

/** 规范化粘贴文本：CRLF → LF，去掉末尾一个换行（Windows 复制常带）。 */
function normalizePasteText(text: string): string {
  let normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1);
  return normalized;
}

// ---------- 扩展 ----------

export default function rightClickPasteExtension(pi: ExtensionAPI) {
  let capturedTui: AltScreenTui | undefined;
  let pasteInFlight = false;

  async function pasteIntoEditor(tui: AltScreenTui): Promise<void> {
    if (pasteInFlight) return;
    pasteInFlight = true;
    try {
      const focused = tui.getFocusedComponent?.();
      if (!(focused instanceof Editor) || typeof focused.handleInput !== "function") return;
      const raw = await readClipboardText();
      if (!raw) return; // 剪贴板为空或读取失败：静默
      const text = normalizePasteText(raw);
      if (!text) return;
      // 读取期间焦点可能已切换（异步窗口），粘贴前再校验一次
      if (tui.getFocusedComponent?.() !== focused) return;
      focused.handleInput(`\x1b[200~${text}\x1b[201~`);
      tui.requestRender?.();
    } catch {
      // 粘贴是尽力而为的功能
    } finally {
      pasteInFlight = false;
    }
  }

  function attachToTui(tui: TUI): void {
    const altScreen = tui as AltScreenTui;
    // 特征检测：仅全屏 alt-screen 实例有此钩子；防 pi 内部结构变化
    if (typeof altScreen.handleRightClickPaste !== "function") return;
    const original = altScreen.handleRightClickPaste.bind(altScreen);
    altScreen.handleRightClickPaste = (event: SgrMouseEvent): boolean => {
      // 右键按下（button 2；拖动为 2|32=34，释放走 release 标记）
      if (event && !event.release && event.button === 2) {
        void pasteIntoEditor(altScreen);
        return true;
      }
      return original(event);
    };
  }

  function recapture(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tui) => {
        capturedTui = tui as AltScreenTui;
        attachToTui(capturedTui);
        return { render: () => [], invalidate: () => {} };
      });
    } catch {
      // UI 未就绪时忽略
    }
  }

  pi.on("session_start", (_event, ctx) => recapture(ctx));
  // 模式切换会更换 TUI 实例，回合边界重新挂接
  pi.on("agent_start", (_event, ctx) => recapture(ctx));
  pi.on("agent_end", (_event, ctx) => recapture(ctx));
  pi.on("session_shutdown", () => {
    capturedTui = undefined;
  });
}
