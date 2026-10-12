/**
 * codex-footer.ts — Codex(theme.png) 风格自定义 footer
 *
 * 第一行: 模型(琥珀) · 目录(绿) (分支) · 会话标题(淡红 RGB 255,215,215)
 * 第二行: 用量统计(↑↓R/W CH 费用 上下文%) + 扩展状态右对齐合并同一行(窄终端回退两行)
 * 隐藏 pi-thinking-steps 的 "thinking: xxx" 状态。
 *
 * 通过 ctx.ui.setFooter() 接管内置 footer —— 更新 pi / 换机安装无需给 dist 打补丁。
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";

// theme.png 像素采样得到的前景纯色
const MODEL_COLOR = "\x1b[38;2;255;215;175m"; // 模型名浅橙 RGB(255,215,175)
const CWD_COLOR = "\x1b[38;2;175;215;175m"; // 目录浅绿 RGB(175,215,175)
const TITLE_COLOR = "\x1b[38;2;255;215;215m"; // 会话标题淡红 RGB(255,215,215)
const RESET_FG = "\x1b[39m";

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface Snapshot {
	modelId: string;
	reasoning: unknown;
	thinkingLevel: string | undefined;
	cwd: string;
	sessionName: string | undefined;
}

/** 实时统计（按 session 条目数缓存，流式期间每次工具调用完成即刷新）。 */
interface LiveStats {
	key: number;
	totals: Totals;
	latestCacheHitRate: number | undefined;
	contextWindow: number;
	contextPercent: number | null | undefined;
}

function collectUsage(entries: any[]): { totals: Totals; latestCacheHitRate: number | undefined } {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	const add = (u: any) => {
		if (!u || typeof u !== "object") return;
		totals.input += u.input ?? 0;
		totals.output += u.output ?? 0;
		totals.cacheRead += u.cacheRead ?? 0;
		totals.cacheWrite += u.cacheWrite ?? 0;
		totals.cost += typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
	};
	for (const entry of entries) {
		if (entry.type === "usage") {
			add(entry.usage);
		} else if (entry.type === "message" && entry.message?.role === "assistant") {
			add(entry.message.usage);
			const u = entry.message.usage;
			if (u) {
				const denom = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				if (denom > 0) latestCacheHitRate = ((u.cacheRead ?? 0) / denom) * 100;
			}
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			add(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			add(entry.usage);
		}
	}
	return { totals, latestCacheHitRate };
}

function formatTokens(count: number): string {
	return count < 1e3
		? count.toString()
		: count < 1e4
			? `${(count / 1e3).toFixed(1)}k`
			: count < 1e6
				? `${Math.round(count / 1e3)}k`
				: count < 1e7
					? `${(count / 1e6).toFixed(1)}M`
					: `${Math.round(count / 1e6)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
		return rel === "" ? "~" : `~${sep}${rel}`;
	}
	return cwd;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function codexFooter(pi: ExtensionAPI) {
	let registered = false;
	let snap: Snapshot | undefined;

	let ctxRef: ExtensionContext | undefined;
	let statsCache: LiveStats | undefined;

	function snapshot(ctx: ExtensionContext): Snapshot {
		ctxRef = ctx;
		statsCache = undefined;
		return {
			modelId: ctx.model?.id || "no-model",
			reasoning: (ctx.model as any)?.reasoning,
			thinkingLevel: ctx.thinkingLevel,
			cwd: ctx.sessionManager.getCwd(),
			sessionName: ctx.sessionManager.getSessionName(),
		};
	}

	/** 渲染时实时计算用量；条目数未变时走缓存。 */
	function liveStats(): LiveStats | undefined {
		if (!ctxRef) return undefined;
		const entries = ctxRef.sessionManager.getEntries() as any[];
		if (statsCache && statsCache.key === entries.length) return statsCache;
		const { totals, latestCacheHitRate } = collectUsage(entries);
		const cu = ctxRef.getContextUsage();
		statsCache = {
			key: entries.length,
			totals,
			latestCacheHitRate,
			contextWindow: cu?.contextWindow ?? 0,
			contextPercent: cu?.percent ?? undefined,
		};
		return statsCache;
	}

	function statsLine(s: LiveStats, theme: any): string {
		const parts: string[] = [];
		if (s.totals.input) parts.push(`↑${formatTokens(s.totals.input)}`);
		if (s.totals.output) parts.push(`↓${formatTokens(s.totals.output)}`);
		if (s.totals.cacheRead) parts.push(`R${formatTokens(s.totals.cacheRead)}`);
		if (s.totals.cacheWrite) parts.push(`W${formatTokens(s.totals.cacheWrite)}`);
		if ((s.totals.cacheRead > 0 || s.totals.cacheWrite > 0) && s.latestCacheHitRate !== undefined) {
			parts.push(`CH${s.latestCacheHitRate.toFixed(1)}%`);
		}
		if (s.totals.cost) parts.push(`$${s.totals.cost.toFixed(3)}`);
		const pct = s.contextPercent;
		const pctValue = pct ?? 0;
		const display =
			pct === null ? `?/${formatTokens(s.contextWindow)} (auto)` : `${pctValue.toFixed(1)}%/${formatTokens(s.contextWindow)} (auto)`;
		parts.push(pctValue > 90 ? theme.fg("error", display) : pctValue > 70 ? theme.fg("warning", display) : display);
		return parts.join(" ");
	}

	function makeFooter(theme: any, footerData: any) {
		return {
			dispose() {},
			render(width: number): string[] {
				const s = snap;
				const live = liveStats();
				if (!s || !live) return [];
				// 第一行: 模型 · 目录 (分支) · 会话标题
				let modelPart = MODEL_COLOR + s.modelId + RESET_FG;
				if (s.reasoning && s.thinkingLevel && s.thinkingLevel !== "off") {
					modelPart += ` ${theme.fg("dim", s.thinkingLevel)}`;
				}
				const parts = [modelPart, CWD_COLOR + formatCwd(s.cwd) + RESET_FG];
				if (s.sessionName) parts.push(TITLE_COLOR + s.sessionName + RESET_FG);
				const line1 = truncateToWidth(parts.join(theme.fg("dim", " · ")), width, theme.fg("dim", "..."));
				const lines = [line1];
				// 第二行: 用量统计 + 扩展状态(thinking-steps 隐藏)合并同一行
				let statusText = "";
				const statuses: Map<string, string> = footerData.getExtensionStatuses();
				if (statuses.size > 0) {
					statusText = Array.from(statuses.entries())
						.filter(([key]) => key !== "thinking-steps")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.join(" ");
				}
				const stats = statsLine(live, theme);
				const statsW = visibleWidth(stats);
				const statusW = visibleWidth(statusText);
				if (statusText.length > 0 && statsW + 2 + statusW <= width) {
					lines.push(stats + " ".repeat(width - statsW - statusW) + statusText);
				} else if (statusText.length > 0) {
					lines.push(theme.fg("dim", stats), truncateToWidth(statusText, width, theme.fg("dim", "...")));
				} else {
					lines.push(theme.fg("dim", stats));
				}
				return lines;
			},
		};
	}

	function register(ctx: ExtensionContext) {
		if (registered || ctx.mode !== "tui") return;
		registered = true;
		ctx.ui.setFooter((_tui, theme, footerData) => makeFooter(theme, footerData));
	}

	pi.on("session_start", async (_event, ctx) => {
		snap = snapshot(ctx);
		register(ctx);
	});
	pi.on("session_info_changed", async (_event, ctx) => {
		if (snap) snap.sessionName = ctx.sessionManager.getSessionName();
	});
	pi.on("model_select", async (_event, ctx) => {
		if (snap) {
			snap.modelId = ctx.model?.id || "no-model";
			snap.reasoning = (ctx.model as any)?.reasoning;
		}
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.mode === "tui") snap = snapshot(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.mode === "tui") snap = snapshot(ctx);
	});
}
