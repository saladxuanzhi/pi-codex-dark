/**
 * codex-markdown.ts — Codex CLI 风格 Markdown 渲染
 *
 * pi 的 MarkdownTheme 只有单一 mdHeading 色，粗体/斜体也没有颜色。这里在运行时
 * 包装 pi-tui 的 Markdown.prototype.renderToken（不修改 dist、升级 pi 不会失效），
 * 把 Codex 的渲染规则补齐：
 *
 * - h1 粉红加粗下划线、h2 桃橙加粗、h3 淡黄加粗斜体、h4-h6 淡黄斜体（均保留 Codex 的 `#` 前缀）
 * - 粗体/斜体粉红，行内代码浅绿，链接浅蓝下划线（下划线由 pi-tui 自带）
 * - 引用淡粉紫，无序列表圆点青绿，有序列表数字用 ANSI LightBlue
 * - 删除线只加删除线、继承上下文颜色
 *
 * 配色跟随当前主题的 appearance：深色 Catppuccin Mocha，浅色 Catppuccin Latte。
 * 主题值（md* / syntax*）由 themes/codex-dark.json、themes/codex-light.json 提供；
 * 这里只处理主题 schema 表达不了的逐级标题、粗斜体着色和列表标记区分。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type MarkdownTheme,
	Markdown,
	type TextAttributes,
	getTerminalColorMode,
	indexedColor,
	rgbColor,
	styleText,
} from "@earendil-works/pi-tui";

interface Palette {
	/** 标题 h1 / 粗体 / 斜体 */
	rose: Color;
	/** 标题 h2 */
	peach: Color;
	/** 标题 h3-h6 */
	yellow: Color;
	/** 行内代码、字符串 */
	green: Color;
	/** 链接、函数名 */
	blue: Color;
	/** 引用 */
	pink: Color;
	/** 无序列表圆点、运算符 */
	teal: Color;
	/** 有序列表数字：固定 ANSI LightBlue（bright blue = 12），由终端调色板决定实际色值 */
	orderedMarker: Color;
}

const MOCHA: Palette = {
	rose: rgbColor(0xf3, 0x8b, 0xa8),
	peach: rgbColor(0xfa, 0xb3, 0x87),
	yellow: rgbColor(0xf9, 0xe2, 0xaf),
	green: rgbColor(0xa6, 0xe3, 0xa1),
	blue: rgbColor(0x89, 0xb4, 0xfa),
	pink: rgbColor(0xf5, 0xc2, 0xe7),
	teal: rgbColor(0x94, 0xe2, 0xd5),
	orderedMarker: indexedColor(12),
};

const LATTE: Palette = {
	rose: rgbColor(0xd2, 0x0f, 0x39),
	peach: rgbColor(0xfe, 0x64, 0x0b),
	yellow: rgbColor(0xdf, 0x8e, 0x1d),
	green: rgbColor(0x40, 0xa0, 0x2b),
	blue: rgbColor(0x1e, 0x66, 0xf5),
	pink: rgbColor(0xea, 0x76, 0xcb),
	teal: rgbColor(0x17, 0x92, 0x99),
	orderedMarker: indexedColor(12),
};

const PATCH_STATE = Symbol.for("pi-codex-dark:markdown-rendering");

/** 原型上的共享状态：保存原始 renderToken，并让 /reload 后的新扩展实例继续更新 context。 */
interface PatchState {
	original: (
		this: MarkdownInstance,
		token: { type: string; depth?: number; tokens?: unknown[] },
		width: number,
		nextTokenType?: string,
		styleContext?: unknown,
	) => string[];
	ctx?: ExtensionContext;
}

let renderState: PatchState | undefined;
/** 嵌套引用深度：引用行由 pi-tui 用 theme.italic() 包住，不能再套粗斜体的粉红。 */
let quoteDepth = 0;

function currentPalette(): Palette {
	let appearance: "dark" | "light" | undefined;
	try {
		appearance = renderState?.ctx?.ui.theme.appearance;
	} catch {
		// ui.theme 在主题尚未初始化时可能抛错
	}
	if (appearance) return appearance === "light" ? LATTE : MOCHA;

	// 没有扩展上下文或主题不可用时，退回 COLORFGBG（与 pi 的终端亮暗判定一致）
	const background = process.env.COLORFGBG?.split(";").at(-1)?.trim();
	if (background && /^\d{1,2}$/.test(background)) {
		const index = Number(background);
		// 与 Vim 的判定相同：0-6 和 8（如 Solarized Dark 的 bright black）算深色
		if (index === 7 || (index >= 9 && index <= 15)) return LATTE;
	}
	return MOCHA;
}

/** 使用当前 pi 主题做颜色转换（truecolor / 256 色近似），无上下文时退回终端能力检测。 */
function paintAttrs(text: string, attrs: TextAttributes): string {
	try {
		const theme = renderState?.ctx?.ui.theme;
		if (theme) return theme.style(text, attrs);
	} catch {
		// 主题未初始化：走下面的通用路径
	}
	return styleText(text, attrs, getTerminalColorMode());
}

function paint(text: string, fg: Color, attrs?: TextAttributes): string {
	return paintAttrs(text, { fg, ...attrs });
}

function isOrderedMarker(marker: string): boolean {
	return /^\s*\d+[.)]\s/.test(marker);
}

function headingStyle(level: number, palette: Palette) {
	if (level <= 1) {
		return { color: palette.rose, attrs: { bold: true, underline: true } };
	}
	if (level === 2) {
		return { color: palette.peach, attrs: { bold: true } };
	}
	if (level === 3) {
		return { color: palette.yellow, attrs: { bold: true, italic: true } };
	}
	// h4-h6 一律回退到通用标题的黄色，只保留斜体（Codex 的实际行为）
	return { color: palette.yellow, attrs: { italic: true } };
}

type MarkdownInstance = {
	theme: MarkdownTheme;
	renderInlineTokens?: (tokens: unknown[], styleContext: unknown) => string;
	getStylePrefix?: (styleFn: (text: string) => string) => string;
};

function renderCodexHeading(
	md: MarkdownInstance,
	token: { depth: number; tokens?: unknown[] },
	nextTokenType: string | undefined,
	palette: Palette,
): string[] {
	const level = Math.min(Math.max(Number(token.depth) || 1, 1), 6);
	const { color, attrs } = headingStyle(level, palette);
	const styleFn = (text: string) => paint(text, color, attrs);

	// 与 pi-tui 原实现一致：把标题样式上下文传给行内 token，
	// 这样行内代码等元素 reset 之后还能恢复标题颜色。
	const stylePrefix = md.getStylePrefix ? md.getStylePrefix(styleFn) : "";
	const styleContext = { applyText: styleFn, stylePrefix };
	const headingText = md.renderInlineTokens ? md.renderInlineTokens(token.tokens || [], styleContext) : "";

	// Codex 会显示所有级别的 "# " 前缀（pi 原实现只给 h3-h6 显示）。
	const headingPrefix = `${"#".repeat(level)} `;
	const styledHeading = styleFn(headingPrefix) + headingText;

	const lines = [styledHeading];
	if (nextTokenType && nextTokenType !== "space") {
		lines.push("");
	}
	return lines;
}

interface SavedCallbacks {
	bold?: MarkdownTheme["bold"];
	italic?: MarkdownTheme["italic"];
	code?: MarkdownTheme["code"];
	link?: MarkdownTheme["link"];
	quote?: MarkdownTheme["quote"];
	quoteBorder?: MarkdownTheme["quoteBorder"];
	listBullet?: MarkdownTheme["listBullet"];
}

function installPaletteCallbacks(theme: MarkdownTheme, palette: Palette, inQuote: boolean): SavedCallbacks {
	const saved: SavedCallbacks = {
		bold: theme.bold,
		italic: theme.italic,
		code: theme.code,
		link: theme.link,
		quote: theme.quote,
		quoteBorder: theme.quoteBorder,
		listBullet: theme.listBullet,
	};

	// 引用行/引用内文字由外层 theme.quote() 着色；这里只保留字体效果，
	// 否则内层粉红会覆盖掉引用的淡粉紫。
	theme.bold = (text) => (inQuote ? paintAttrs(text, { bold: true }) : paint(text, palette.rose, { bold: true }));
	theme.italic = (text) =>
		inQuote ? paintAttrs(text, { italic: true }) : paint(text, palette.rose, { italic: true });
	theme.code = (text) => paint(text, palette.green);
	theme.link = (text) => paint(text, palette.blue);
	theme.quote = (text) => paint(text, palette.pink);
	theme.quoteBorder = (text) => paint(text, palette.pink);
	theme.listBullet = (marker) =>
		paint(marker, isOrderedMarker(marker) ? palette.orderedMarker : palette.teal);

	return saved;
}

function restoreCallbacks(theme: MarkdownTheme, saved: SavedCallbacks): void {
	if (saved.bold) theme.bold = saved.bold;
	if (saved.italic) theme.italic = saved.italic;
	if (saved.code) theme.code = saved.code;
	if (saved.link) theme.link = saved.link;
	if (saved.quote) theme.quote = saved.quote;
	if (saved.quoteBorder) theme.quoteBorder = saved.quoteBorder;
	if (saved.listBullet) theme.listBullet = saved.listBullet;
}

function patchMarkdown(): void {
	const proto = Markdown.prototype as unknown as Record<PropertyKey, unknown>;

	const existing = proto[PATCH_STATE] as PatchState | undefined;
	const state: PatchState = existing ?? {
		original: proto.renderToken as PatchState["original"],
	};
	// 每次加载扩展都换上新 wrapper：/reload 后旧闭包不会继续持有已经失效的 ctx。
	proto[PATCH_STATE] = state;
	renderState = state;

	const originalRenderToken = state.original;
	if (typeof originalRenderToken !== "function") return;

	proto.renderToken = function codexRenderToken(
		this: MarkdownInstance,
		token: { type: string; depth?: number; tokens?: unknown[] },
		width: number,
		nextTokenType?: string,
		styleContext?: unknown,
	): string[] {
		// 只处理走 Markdown 组件的文本；自定义主题实例也保持同样的排版语义。
		if (!token || typeof token !== "object") return originalRenderToken.call(this, token, width, nextTokenType, styleContext);

		const palette = currentPalette();
		const inQuote = token.type === "blockquote" || quoteDepth > 0;
		const saved = installPaletteCallbacks(this.theme, palette, inQuote);

		if (token.type === "blockquote") quoteDepth++;
		try {
			if (token.type === "heading") {
				return renderCodexHeading(this, token, nextTokenType, palette);
			}
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		} finally {
			if (token.type === "blockquote") quoteDepth--;
			restoreCallbacks(this.theme, saved);
		}
	};
}

export default function codexMarkdownExtension(pi: ExtensionAPI) {
	patchMarkdown();
	pi.on("session_start", (_event, ctx) => {
		if (renderState) renderState.ctx = ctx;
	});
}
