/**
 * Local copy of npm:pi-task-title v0.1.3 (unpatched, persists session titles again).
 */
import type { UserMessage } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LONG_TASK_THRESHOLD_MS = 10_000;
const NOTIFICATION_CONFIG_PATH = join(getAgentDir(), "pi-task-title.json");
const NOTIFICATION_OPTIONS = [
	{ mode: "always", label: "On: notify for all tasks" },
	{ mode: "long", label: "On: notify only for tasks that take at least 10 seconds" },
	{ mode: "off", label: "Off: disable notifications" },
] as const;
type NotificationMode = (typeof NOTIFICATION_OPTIONS)[number]["mode"];
type TaskOutcome = "completed" | "aborted" | "error" | "truncated";
type TitleRequestOptions = {
	signal: AbortSignal;
	maxTokens: number;
	cacheRetention: "none";
	[key: string]: unknown;
};

const TITLE_SYSTEM_PROMPT = [
	"Generate a concise terminal title for the coding task.",
	"Summarize the user's intent in the same language they used.",
	"Use 4 to 12 characters for Chinese and no more than 8 words for other languages.",
	"Output only the plain-text title, without quotes, periods, Markdown, or explanations.",
].join("\n");

/** Read the notification mode from global config, defaulting to all tasks if absent or invalid. */
function loadNotificationMode(): NotificationMode {
	try {
		const config = JSON.parse(readFileSync(NOTIFICATION_CONFIG_PATH, "utf8")) as { notificationMode?: unknown };
		if (NOTIFICATION_OPTIONS.some((option) => option.mode === config.notificationMode)) {
			return config.notificationMode as NotificationMode;
		}
	} catch {
		// Use the default on first use or invalid config without blocking extension loading.
	}
	return "always";
}

/** Save the selected notification mode to Pi's global config directory. */
function saveNotificationMode(mode: NotificationMode): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(NOTIFICATION_CONFIG_PATH, `${JSON.stringify({ notificationMode: mode }, null, 2)}\n`, "utf8");
}

/** Decide whether to send a completion notification based on mode and duration. */
function shouldNotify(mode: NotificationMode, elapsedMs: number): boolean {
	return mode === "always" || (mode === "long" && elapsedMs >= LONG_TASK_THRESHOLD_MS);
}

/** Format task duration for notification display. */
function formatElapsedTime(elapsedMs: number): string {
	const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds} sec`;

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours} hr${minutes ? ` ${minutes} min` : ""}`;
	return `${minutes} min${seconds ? ` ${seconds} sec` : ""}`;
}

/** Disable or reduce thinking by API and limit caching and output for the one-shot title request. */
function createTitleRequestOptions(api: string, reasoning: boolean, signal: AbortSignal): TitleRequestOptions {
	const options: TitleRequestOptions = { signal, maxTokens: 64, cacheRetention: "none" };
	// ark 等 openai-completions 网关默认路由到推理模型：不压缩推理时 64 个 token 会被
	// reasoning 耗尽，content 为空，标题退回首句原文。因此无论模型是否声明 reasoning，
	// 都显式要求 minimal 推理（实测 ark 接受 minimal 并正常返回标题）。
	if (api === "openai-completions") return { ...options, reasoningEffort: "minimal" };
	if (!reasoning) return options;
	switch (api) {
		case "anthropic-messages":
			return { ...options, thinkingEnabled: false };
		case "google-generative-ai":
		case "google-vertex":
			return { ...options, thinking: { enabled: false } };
		case "openai-codex-responses":
			return { ...options, reasoningEffort: "none", reasoningSummary: "off", textVerbosity: "low" };
		case "mistral-conversations":
			return { ...options, reasoningEffort: "none" };
		case "openai-completions":
			return { ...options, reasoningEffort: "minimal" };
		case "openai-responses":
		case "azure-openai-responses":
			return { ...options, maxTokens: 512, reasoningEffort: "low" };
		default:
			return options;
	}
}

/** Strip control characters and decoration from model or user input before using it as a terminal title. */
function normalizeTitle(text: string): string {
	const firstLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("```"))
		?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^(?:#{1,6}|[-+*>\u2022]|\d+[.)])\s+/, "")
		.replace(/^(?:\u6807\u9898|Title)\s*[:\uff1a]\s*/i, "")
		.replace(/^(?:\*\*|__|~~|`|["'\u201c\u201d\u2018\u2019])+|(?:\*\*|__|~~|`|["'\u201c\u201d\u2018\u2019\u3002.!\uff01])+$/g, "")
		.trim();

	return Array.from(firstLine || "New task").slice(0, 36).join("");
}

/** Create a usable, length-limited title from the first task when model summarization is unavailable. */
function fallbackTitle(prompt: string): string {
	return normalizeTitle(prompt);
}

/** Extract the actual task from a raw slash command or expanded skill message instead of summarizing the skill body. */
function extractTaskPrompt(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;

	const skill = trimmed.match(/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (skill) return skill[2]?.trim() || `/skill:${skill[1]}`;

	if (trimmed.startsWith("/")) {
		const spaceIndex = trimmed.indexOf(" ");
		const rest = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1).trim() : "";
		if (rest) return rest;
	}
	return trimmed;
}

/** Extract text from a session message or model response. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	let text = "";
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as { type?: string; text?: string };
		if (part.type === "text" && part.text) text += `${part.text}\n`;
	}
	return text;
}

/** Find the session's actual first user prompt, including when the plugin is first loaded into an existing session. */
function findFirstUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user") continue;
		const text = extractTaskPrompt(extractText(message.content).trim());
		if (text) return text;
	}
	return undefined;
}

/** Derive the final task outcome from the last assistant message. */
function getTaskOutcome(messages: unknown[]): TaskOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; stopReason?: string };
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return "error";
		if (message.stopReason === "length") return "truncated";
		// The terminate tool may finish normally with toolUse; pending/deferred should not be final, so treat them as completed.
		return "completed";
	}
	return "error";
}

/** Pass a control sequence to the terminal, wrapping it in DCS under tmux. */
function writeTerminalSequence(sequence: string): void {
	if (process.env.TMUX) {
		process.stdout.write(`\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
		return;
	}
	process.stdout.write(sequence);
}

/** Send a Ghostty, iTerm2, or WezTerm notification with OSC 777. */
function notifyOsc777(title: string, body: string): void {
	writeTerminalSequence(`\x1b]777;notify;${title};${body}\x07`);
}

/** Send a Kitty notification with OSC 99. */
function notifyOsc99(title: string, body: string): void {
	writeTerminalSequence(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	writeTerminalSequence(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

/** Escape a PowerShell single-quoted string so title content cannot break the notification script. */
function escapePowerShellLiteral(text: string): string {
	return text.replaceAll("'", "''");
}

/** Send a system toast in Windows Terminal under WSL. */
function notifyWindows(title: string, body: string): void {
	const type = "Windows.UI.Notifications";
	const safeTitle = escapePowerShellLiteral(title);
	const safeBody = escapePowerShellLiteral(body);
	const script = [
		`[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${safeBody}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${safeTitle}').Show([${type}.ToastNotification]::new($xml))`,
	].join("; ");
	execFile("powershell.exe", ["-NoProfile", "-Command", script], () => {});
}

/** Send a task completion notification with its outcome and duration using the terminal's capabilities. */
function notifyTaskSettled(title: string, outcome: TaskOutcome, elapsedMs: number): void {
	const safeTitle = normalizeTitle(title).replaceAll(";", ",");
	const outcomeText =
		outcome === "completed"
			? "completed"
			: outcome === "aborted"
				? "aborted"
				: outcome === "truncated"
					? "output truncated"
					: "failed";
	const body = `${safeTitle} ${outcomeText} in ${formatElapsedTime(elapsedMs)}`;
	if (process.env.WT_SESSION) notifyWindows("Pi", body);
	else if (process.env.KITTY_WINDOW_ID) notifyOsc99("Pi", body);
	else notifyOsc777("Pi", body);
}

/** Register first-task summarization, the terminal-title loading animation, and completion notifications. */
export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let frameIndex = 0;
	let taskTitle: string | undefined;
	let firstPrompt: string | undefined;
	let pendingRawPrompt: string | undefined;
	let pendingSessionName: string | undefined;
	let titleGenerated = false;
	let titleRequestId = 0;
	let titleAbortController: AbortController | undefined;
	let sessionGeneration = 0;
	let taskStartedAt: number | undefined;
	let taskOutcome: TaskOutcome = "error";
	let notificationMode = loadNotificationMode();

	/** Build the base terminal title without a loading state. */
	function getBaseTitle(ctx: ExtensionContext): string {
		const cwd = path.basename(ctx.cwd);
		return taskTitle ? `π - ${taskTitle} - ${cwd}` : `π - ${cwd}`;
	}

	/** Render immediately and keep updating the loading title while work is in progress. */
	function startLoading(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (timer) clearInterval(timer);
		timer = undefined;
		frameIndex = 0;

		/** Advance and render the next loading frame. */
		const renderFrame = () => {
			const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
			ctx.ui.setTitle(`${frame} ${getBaseTitle(ctx)}`);
			frameIndex++;
		};

		renderFrame();
		timer = setInterval(renderFrame, 80);
	}

	/** Stop loading and restore the current task summary title. */
	function stopLoading(ctx: ExtensionContext): void {
		if (timer) clearInterval(timer);
		timer = undefined;
		frameIndex = 0;
		applyIdleTitle(ctx);
	}

	/** Set the static title while idle; set it again after session start to override Pi's built-in updateTerminalTitle. */
	function applyIdleTitle(ctx: ExtensionContext): void {
		if (timer || ctx.mode !== "tui") return;
		ctx.ui.setTitle(getBaseTitle(ctx));
	}

	/** Local modification: never persist the generated title as the session name. */
	/** Persist a pending title only while idle to avoid inserting a session_info node into an active session tree. */
	function commitPendingSessionName(ctx: ExtensionContext): void {
		if (!pendingSessionName || !ctx.isIdle() || taskStartedAt !== undefined) return;
		const name = pendingSessionName;
		pendingSessionName = undefined;
		if (pi.getSessionName() === name) return;
		pi.setSessionName(name);
	}

	/** Summarize the first task with the current model in the background without letting stale results overwrite newer sessions or manual names. */
	async function generateFirstTaskTitle(prompt: string, ctx: ExtensionContext, generation: number): Promise<void> {
		if (titleGenerated || ctx.mode !== "tui") return;
		titleGenerated = true;
		firstPrompt = prompt;
		let resolvedTitle = fallbackTitle(prompt);
		taskTitle = resolvedTitle;
		const requestId = ++titleRequestId;
		const controller = new AbortController();
		titleAbortController?.abort();
		titleAbortController = controller;
		applyIdleTitle(ctx);

		if (ctx.model) {
			try {
				// ponytail: only the first 6,000 characters are used; pass the full text if precise summaries of longer tasks become necessary.
				const message: UserMessage = {
					role: "user",
					content: [{ type: "text", text: prompt.slice(0, 6000) }],
					timestamp: Date.now(),
				};
				const response = await ctx.modelRegistry.complete(
					ctx.model,
					{ systemPrompt: TITLE_SYSTEM_PROMPT, messages: [message] },
					createTitleRequestOptions(ctx.model.api, ctx.model.reasoning, controller.signal),
				);
				const generatedTitle = extractText(response.content);
				if (generatedTitle.trim()) resolvedTitle = normalizeTitle(generatedTitle);
			} catch {
				// Summarization is only a terminal enhancement; fall back to the local first-task title on failure.
			}
		}
		if (titleAbortController === controller) titleAbortController = undefined;

		if (generation !== sessionGeneration || requestId !== titleRequestId) return;
		taskTitle = resolvedTitle;
		pendingSessionName = resolvedTitle;
		applyIdleTitle(ctx);
		commitPendingSessionName(ctx);
	}

	// Capture the first raw input before skill and template expansion to avoid titling from expanded instructions.
	pi.on("input", async (event) => {
		if (titleGenerated || firstPrompt || pendingRawPrompt) return;
		const rawPrompt = extractTaskPrompt(event.text);
		if (rawPrompt) pendingRawPrompt = rawPrompt;
	});

	// Restore the title on session start; generate one in the background for an existing unnamed session from its actual first user prompt.
	pi.on("session_start", async (_event, ctx) => {
		titleAbortController?.abort();
		titleAbortController = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		frameIndex = 0;
		sessionGeneration++;
		titleRequestId++;
		taskTitle = pi.getSessionName();
		titleGenerated = Boolean(taskTitle);
		firstPrompt = findFirstUserPrompt(ctx);
		pendingRawPrompt = undefined;
		pendingSessionName = undefined;
		taskStartedAt = undefined;
		taskOutcome = "error";
		if (firstPrompt && !taskTitle) {
			void generateFirstTaskTitle(firstPrompt, ctx, sessionGeneration);
		}
		applyIdleTitle(ctx);
		const generation = sessionGeneration;
		setTimeout(() => {
			if (generation !== sessionGeneration) return;
			applyIdleTitle(ctx);
		}, 0);
	});

	// Start loading immediately; generate the first summary in the background without blocking the main task.
	pi.on("before_agent_start", async (event, ctx) => {
		if (taskStartedAt === undefined) {
			taskStartedAt = Date.now();
			taskOutcome = "error";
		}
		const titlePrompt = pendingRawPrompt || firstPrompt || extractTaskPrompt(event.prompt);
		pendingRawPrompt = undefined;
		void generateFirstTaskTitle(titlePrompt, ctx, sessionGeneration);
		startLoading(ctx);
	});

	// Keep the loading animation active during automatic retries or continuation.
	pi.on("agent_start", async (_event, ctx) => {
		taskStartedAt ??= Date.now();
		startLoading(ctx);
	});

	// Record the latest outcome after each low-level agent run so a final retry result replaces the preceding error.
	pi.on("agent_end", async (event) => {
		taskOutcome = getTaskOutcome(event.messages);
	});

	// Persist the title, restore display, and notify with the final outcome only after retries, compaction, and queued tasks settle.
	pi.on("agent_settled", async (_event, ctx) => {
		const elapsedMs = taskStartedAt ? Date.now() - taskStartedAt : 0;
		taskStartedAt = undefined;
		stopLoading(ctx);
		commitPendingSessionName(ctx);
		if (ctx.mode === "tui" && shouldNotify(notificationMode, elapsedMs)) {
			notifyTaskSettled(taskTitle ?? path.basename(ctx.cwd), taskOutcome, elapsedMs);
		}
	});

	// Keep the terminal title in sync when the user renames the session with /name.
	pi.on("session_info_changed", async (event, ctx) => {
		titleAbortController?.abort();
		titleAbortController = undefined;
		titleRequestId++;
		pendingSessionName = undefined;
		taskTitle = event.name ?? (firstPrompt ? fallbackTitle(firstPrompt) : undefined);
		applyIdleTitle(ctx);
	});

	// Clear timers on reload, session switches, or exit so stale instances cannot keep refreshing the title.
	pi.on("session_shutdown", async (_event, ctx) => {
		titleAbortController?.abort();
		titleAbortController = undefined;
		sessionGeneration++;
		titleRequestId++;
		pendingSessionName = undefined;
		taskStartedAt = undefined;
		stopLoading(ctx);
	});

	/** Show the notification mode menu and persist the selection immediately. */
	async function handleNotificationCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") return;
		const currentLabel = NOTIFICATION_OPTIONS.find((option) => option.mode === notificationMode)?.label;
		const choice = await ctx.ui.select(
			`Task completion notifications (current: ${currentLabel})`,
			NOTIFICATION_OPTIONS.map((option) => option.label),
		);
		const selected = NOTIFICATION_OPTIONS.find((option) => option.label === choice);
		if (!selected) return;

		try {
			saveNotificationMode(selected.mode);
			notificationMode = selected.mode;
			ctx.ui.notify(`Task completion notifications: ${selected.label}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			ctx.ui.notify(`Failed to save notification settings: ${message}`, "error");
		}
	}

	pi.registerCommand("notify", { description: "Configure Pi task completion notifications", handler: handleNotificationCommand });
	pi.registerCommand("task-title-notify", { description: "Configure Pi Task Title notifications", handler: handleNotificationCommand });
}
