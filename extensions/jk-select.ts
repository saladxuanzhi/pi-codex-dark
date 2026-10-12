/**
 * jk-select — 让 j/k 在所有“选项列表”（SelectList / SettingsList 等）里像 vim 一样
 * 上下移动选中项，同时不影响任何地方正常输入 j/k 字母。
 *
 * 实现原理：
 * - j/k 的选项移动靠 ~/.pi/agent/keybindings.json 里的
 *     "tui.select.up": ["up", "k"] / "tui.select.down": ["down", "j"]
 *   所有使用 tui.select.up/down 的列表组件（含 /my-pi settings）自动获得 j/k 导航。
 * - 唯一冲突：主编辑器的自动补全（输入 / 或 @ 后）也会查这两个动作，导致 j/k 无法输入。
 *   本扩展在每次按键前检查焦点状态：焦点在主编辑器且自动补全激活时，
 *   动态从键位表中摘除 j/k（此刻 j/k 恢复为普通字母）；其余时候恢复绑定。
 * - 扩展从不吞键、从不改写按键，只做键位表同步，因此对其他扩展（游戏/覆盖层）
 *   和普通打字零影响；值输入框（如 /my-pi 的编辑子菜单）里的 j/k 也照常输入。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, getKeybindings } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

const SELECT_UP = "tui.select.up";
const SELECT_DOWN = "tui.select.down";
const WIDGET_KEY = "jk-select";

export default function jkSelectExtension(pi: ExtensionAPI) {
  let capturedTui: TUI | undefined;
  let offInput: (() => void) | undefined;

  // 焦点在主编辑器且自动补全下拉打开时返回 true
  function isEditorAutocompleteActive(focused: unknown): boolean {
    if (!(focused instanceof Editor)) return false;
    const anyEditor = focused as unknown as {
      autocompleteState?: unknown;
      autocompleteList?: unknown;
    };
    return Boolean(anyEditor.autocompleteState && anyEditor.autocompleteList);
  }

  function withoutJk(keys: string[]): string[] {
    return keys.filter((k) => k !== "j" && k !== "k");
  }

  function defaultKeysFor(kb: ReturnType<typeof getKeybindings>, action: string): string[] {
    try {
      const def = kb.getDefinition(action) as { defaultKeys?: string[] } | undefined;
      if (def?.defaultKeys?.length) return [...def.defaultKeys];
    } catch {
      // 忽略
    }
    return action === SELECT_UP ? ["up"] : ["down"];
  }

  /**
   * 让键位表与期望状态一致：wantJk=true 时 tui.select.up/down 含 k/j，
   * false 时不含。只在状态变化时调用 setUserBindings（避免每次按键重建表）。
   */
  function syncJkState(wantJk: boolean): void {
    try {
      const kb = getKeybindings();
      const resolvedUp = kb.getKeys(SELECT_UP);
      const resolvedDown = kb.getKeys(SELECT_DOWN);
      const hasJk = resolvedUp.includes("k") || resolvedDown.includes("j");
      if (wantJk === hasJk) return;

      const user = { ...kb.getUserBindings() };
      if (wantJk) {
        if (!resolvedUp.includes("k")) user[SELECT_UP] = [...resolvedUp, "k"];
        if (!resolvedDown.includes("j")) user[SELECT_DOWN] = [...resolvedDown, "j"];
      } else {
        const up = withoutJk(resolvedUp);
        const down = withoutJk(resolvedDown);
        // 防御：摘除后为空则回退到默认键，避免把方向键也一起禁掉
        user[SELECT_UP] = up.length > 0 ? up : defaultKeysFor(kb, SELECT_UP);
        user[SELECT_DOWN] = down.length > 0 ? down : defaultKeysFor(kb, SELECT_DOWN);
      }
      kb.setUserBindings(user);
    } catch {
      // 键位表异常时静默跳过，绝不影响按键
    }
  }

  const handleInput = (): undefined => {
    try {
      const focused = capturedTui?.getFocusedComponent?.();
      syncJkState(!isEditorAutocompleteActive(focused));
    } catch {
      // 任何异常都放行按键
    }
    return undefined;
  };

  // 借助不可见 widget 捕获当前 TUI（模式切换后通过回合边界事件刷新）
  function recapture(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tui) => {
        capturedTui = tui;
        return { render: () => [], invalidate: () => {} };
      });
    } catch {
      // UI 未就绪时忽略
    }
  }

  pi.on("session_start", (_event, ctx) => {
    offInput?.();
    offInput = undefined;
    capturedTui = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    recapture(ctx);
    offInput = ctx.ui.onTerminalInput(handleInput);
  });
  pi.on("agent_start", (_event, ctx) => recapture(ctx));
  pi.on("agent_end", (_event, ctx) => recapture(ctx));
  pi.on("session_shutdown", () => {
    offInput?.();
    offInput = undefined;
    capturedTui = undefined;
    // 恢复 keybindings.json 的原始状态（reload 是 pi 侧子类的方法）
    try {
      (getKeybindings() as unknown as { reload?: () => void }).reload?.();
    } catch {
      // 忽略
    }
  });
}
