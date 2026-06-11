import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const EXTENSION_ID = "pi-repo-spend";
const COMMAND = "repo-spend";
const MILLION = 1_000_000;

type NumericTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	recordedCost: number;
	estimatedCost: number;
	calls: number;
};

type Price = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite?: number;
	source: string;
};

type ModelTotals = NumericTotals & {
	provider: string;
	model: string;
	api: string;
	pricingSource?: string;
};

type RepoTotals = NumericTotals & {
	cwd: string;
	label: string;
	sessions: number;
	topModel?: string;
};

type RepoAccumulator = RepoTotals & {
	models: Map<string, NumericTotals>;
};

type TimeBucketTotals = NumericTotals & {
	period: string;
};

type ScanMode = "repo" | "all" | "cwd";
type ReportView = "dashboard" | "text";

type ParsedArgs = {
	mode: ScanMode;
	view: ReportView;
};

type ScanResult = {
	mode: ScanMode;
	repoRoot: string;
	cwd: string;
	sessionRoot: string;
	filesScanned: number;
	filesIncluded: number;
	parseErrors: number;
	oldest?: string;
	newest?: string;
	totals: NumericTotals;
	byModel: ModelTotals[];
	byProvider: ModelTotals[];
	byRepo: RepoTotals[];
	byMonth: TimeBucketTotals[];
	byDay: TimeBucketTotals[];
};

const OLLAMA_CLOUD_PRICES: Record<string, Price> = {
	"deepseek-v4-pro:cloud": {
		input: 0.435,
		output: 0.87,
		cacheRead: 0.003625,
		source: "DeepSeek official API pricing used as Ollama Cloud estimate",
	},
	"glm-5.1:cloud": {
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		source: "Z.AI official GLM-5.1 pricing used as Ollama Cloud estimate",
	},
	"kimi-k2.6:cloud": {
		input: 0.95,
		output: 4.0,
		cacheRead: 0.16,
		source: "Kimi official K2.6 pricing used as Ollama Cloud estimate",
	},
	"minimax-m3:cloud": {
		input: 0.3,
		output: 1.2,
		cacheRead: 0.06,
		source: "MiniMax official M3 standard <=512k discounted tier used as Ollama Cloud estimate",
	},
	"qwen3.5:cloud": {
		input: 0.6,
		output: 3.6,
		cacheRead: 0.6,
		source: "Qwen3.5 397B public API estimate used as Ollama Cloud estimate",
	},
	"nemotron-3-ultra:cloud": {
		input: 0.6,
		output: 3.6,
		cacheRead: 0.2,
		source: "NVIDIA Nemotron 3 Ultra Together/NVIDIA route used as Ollama Cloud estimate",
	},
};

function blankTotals(): NumericTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		recordedCost: 0,
		estimatedCost: 0,
		calls: 0,
	};
}

function addInto(target: NumericTotals, source: Partial<NumericTotals>) {
	target.input += source.input ?? 0;
	target.output += source.output ?? 0;
	target.cacheRead += source.cacheRead ?? 0;
	target.cacheWrite += source.cacheWrite ?? 0;
	target.totalTokens += source.totalTokens ?? 0;
	target.recordedCost += source.recordedCost ?? 0;
	target.estimatedCost += source.estimatedCost ?? 0;
	target.calls += source.calls ?? 0;
}

function normalizeOllamaModel(model: string): string {
	return model
		.toLowerCase()
		.replace(/^ollama-cloud\//, "")
		.replace(/-cloud$/, ":cloud");
}

function estimateOllamaCost(model: string, usage: any): { cost: number; source?: string } {
	const price = OLLAMA_CLOUD_PRICES[normalizeOllamaModel(model)];
	if (!price) return { cost: 0 };

	const input = Number(usage?.input ?? 0);
	const output = Number(usage?.output ?? 0);
	const cacheRead = Number(usage?.cacheRead ?? 0);
	const cacheWrite = Number(usage?.cacheWrite ?? 0);

	const cost =
		(input * price.input +
			output * price.output +
			cacheRead * price.cacheRead +
			cacheWrite * (price.cacheWrite ?? price.input)) /
		MILLION;

	return { cost, source: price.source };
}

function sessionRoot(): string {
	if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "sessions");
}

async function listJsonlFiles(dir: string): Promise<string[]> {
	let files: string[] = [];
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files = files.concat(await listJsonlFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(fullPath);
		}
	}
	return files;
}

function isSameOrInside(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 3000 });
		const root = result.stdout.trim();
		if (result.code === 0 && root) return path.resolve(root);
	} catch {
		// Fall through to cwd.
	}
	return path.resolve(cwd);
}

function shouldIncludeSession(headerCwd: string | undefined, mode: ScanMode, cwd: string, repoRoot: string): boolean {
	if (mode === "all") return true;
	if (!headerCwd) return false;
	if (mode === "cwd") return path.resolve(headerCwd) === path.resolve(cwd);
	return isSameOrInside(headerCwd, repoRoot);
}

function repoLabel(cwd: string): string {
	const resolved = path.resolve(cwd);
	const name = path.basename(resolved) || resolved;
	return `${name} (${resolved})`;
}

function finalizeRepo(acc: RepoAccumulator): RepoTotals {
	let topModel: string | undefined;
	let topModelScore = -1;
	for (const [model, totals] of acc.models) {
		const score = totalCost(totals) > 0 ? totalCost(totals) : totals.totalTokens / MILLION;
		if (score > topModelScore) {
			topModelScore = score;
			topModel = model;
		}
	}
	const { models: _models, ...repo } = acc;
	return { ...repo, topModel };
}

function addToTimeBucket(map: Map<string, TimeBucketTotals>, period: string | undefined, item: Partial<NumericTotals>) {
	if (!period) return;
	let totals = map.get(period);
	if (!totals) {
		totals = { ...blankTotals(), period };
		map.set(period, totals);
	}
	addInto(totals, item);
}

function entryTimestampIso(entry: any, fallback?: string): string | undefined {
	if (typeof entry?.timestamp === "string") return entry.timestamp;
	const messageTimestamp = entry?.message?.timestamp;
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
		return new Date(messageTimestamp).toISOString();
	}
	if (typeof messageTimestamp === "string") {
		const date = new Date(messageTimestamp);
		if (!Number.isNaN(date.getTime())) return date.toISOString();
	}
	return fallback;
}

async function scanSpend(pi: ExtensionAPI, cwd: string, mode: ScanMode): Promise<ScanResult> {
	const root = sessionRoot();
	const repoRoot = await getRepoRoot(pi, cwd);
	const files = await listJsonlFiles(root);
	const totals = blankTotals();
	const byModelMap = new Map<string, ModelTotals>();
	const byProviderMap = new Map<string, ModelTotals>();
	const byRepoMap = new Map<string, RepoAccumulator>();
	const byMonthMap = new Map<string, TimeBucketTotals>();
	const byDayMap = new Map<string, TimeBucketTotals>();
	let filesIncluded = 0;
	let parseErrors = 0;
	let oldest: string | undefined;
	let newest: string | undefined;

	for (const file of files) {
		let text: string;
		let headerCwd: string | undefined;
		try {
			text = await readFile(file, "utf8");
			const firstLine = text.split("\n", 1)[0];
			const header = firstLine ? JSON.parse(firstLine) : undefined;
			headerCwd = header?.cwd;
			if (!shouldIncludeSession(headerCwd, mode, cwd, repoRoot)) continue;
		} catch {
			parseErrors++;
			continue;
		}

		filesIncluded++;
		const repoKey = headerCwd ? path.resolve(headerCwd) : "<unknown cwd>";
		let repoTotals = byRepoMap.get(repoKey);
		if (!repoTotals) {
			repoTotals = { ...blankTotals(), cwd: repoKey, label: repoLabel(repoKey), sessions: 0, models: new Map() };
			byRepoMap.set(repoKey, repoTotals);
		}
		repoTotals.sessions++;

		const fileStat = await stat(file).catch(() => undefined);
		const fileMtime = fileStat?.mtime.toISOString();
		if (fileMtime) {
			if (!oldest || fileMtime < oldest) oldest = fileMtime;
			if (!newest || fileMtime > newest) newest = fileMtime;
		}

		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				parseErrors++;
				continue;
			}

			const message = entry?.message;
			if (!message || message.role !== "assistant" || !message.usage) continue;

			const provider = String(message.provider ?? "unknown");
			const model = String(message.model ?? "unknown");
			const api = String(message.api ?? "unknown");
			const usage = message.usage;
			const recordedCost = Number(usage?.cost?.total ?? 0);
			const ollamaEstimate = provider === "ollama" ? estimateOllamaCost(model, usage) : { cost: 0 };
			const estimatedCost = recordedCost > 0 ? 0 : ollamaEstimate.cost;

			const item: Partial<NumericTotals> = {
				input: Number(usage.input ?? 0),
				output: Number(usage.output ?? 0),
				cacheRead: Number(usage.cacheRead ?? 0),
				cacheWrite: Number(usage.cacheWrite ?? 0),
				totalTokens: Number(usage.totalTokens ?? 0),
				recordedCost,
				estimatedCost,
				calls: 1,
			};
			addInto(totals, item);
			addInto(repoTotals, item);
			if (mode === "cwd") {
				const timestamp = entryTimestampIso(entry, fileMtime);
				addToTimeBucket(byMonthMap, timestamp?.slice(0, 7), item);
				addToTimeBucket(byDayMap, timestamp?.slice(0, 10), item);
			}
			const repoModelKey = `${provider}/${model}`;
			let repoModelTotals = repoTotals.models.get(repoModelKey);
			if (!repoModelTotals) {
				repoModelTotals = blankTotals();
				repoTotals.models.set(repoModelKey, repoModelTotals);
			}
			addInto(repoModelTotals, item);

			const modelKey = `${provider}\t${model}\t${api}`;
			let modelTotals = byModelMap.get(modelKey);
			if (!modelTotals) {
				modelTotals = { ...blankTotals(), provider, model, api, pricingSource: ollamaEstimate.source };
				byModelMap.set(modelKey, modelTotals);
			}
			addInto(modelTotals, item);
			if (!modelTotals.pricingSource && ollamaEstimate.source) modelTotals.pricingSource = ollamaEstimate.source;

			let providerTotals = byProviderMap.get(provider);
			if (!providerTotals) {
				providerTotals = { ...blankTotals(), provider, model: "*", api: "*" };
				byProviderMap.set(provider, providerTotals);
			}
			addInto(providerTotals, item);
		}
	}

	return {
		mode,
		repoRoot,
		cwd,
		sessionRoot: root,
		filesScanned: files.length,
		filesIncluded,
		parseErrors,
		oldest,
		newest,
		totals,
		byModel: [...byModelMap.values()].sort((a, b) => totalCost(b) - totalCost(a)),
		byProvider: [...byProviderMap.values()].sort((a, b) => totalCost(b) - totalCost(a)),
		byRepo: [...byRepoMap.values()].map(finalizeRepo).sort((a, b) => totalCost(b) - totalCost(a)),
		byMonth: [...byMonthMap.values()].sort((a, b) => b.period.localeCompare(a.period)),
		byDay: [...byDayMap.values()].sort((a, b) => b.period.localeCompare(a.period)),
	};
}

function totalCost(t: NumericTotals): number {
	return t.recordedCost + t.estimatedCost;
}

function fmtInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function fmtMoney(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "$0.00";
	if (Math.abs(n) < 0.01) return `$${n.toFixed(6)}`;
	return `$${n.toFixed(2)}`;
}

function fmtDate(value?: string): string {
	if (!value) return "n/a";
	return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function fmtCompact(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const abs = Math.abs(n);
	if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
	if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return Math.round(n).toString();
}

function percent(part: number, total: number): string {
	if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "0%";
	return `${Math.round((part / total) * 100)}%`;
}

function padAnsi(text: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(text));
	return text + " ".repeat(pad);
}

function row(label: string, value: string | number): string {
	return `| ${label} | ${value} |`;
}

function modelRow(item: ModelTotals): string {
	return [
		`\`${item.provider}/${item.model}\``,
		fmtInt(item.calls),
		fmtInt(item.totalTokens),
		fmtInt(item.input),
		fmtInt(item.output),
		fmtInt(item.cacheRead),
		fmtMoney(item.recordedCost),
		fmtMoney(item.estimatedCost),
		fmtMoney(totalCost(item)),
	].join(" | ");
}

function providerRow(item: ModelTotals): string {
	return [
		`\`${item.provider}\``,
		fmtInt(item.calls),
		fmtInt(item.totalTokens),
		fmtMoney(item.recordedCost),
		fmtMoney(item.estimatedCost),
		fmtMoney(totalCost(item)),
	].join(" | ");
}

function repoRow(item: RepoTotals): string {
	return [
		` ${item.label.replace(/`/g, "")} `,
		fmtInt(item.sessions),
		fmtInt(item.calls),
		fmtInt(item.totalTokens),
		fmtMoney(item.recordedCost),
		fmtMoney(item.estimatedCost),
		fmtMoney(totalCost(item)),
		item.topModel ? `\`${item.topModel}\`` : "n/a",
	].join(" | ");
}

function timeBucketRow(item: TimeBucketTotals): string {
	return [
		item.period,
		fmtInt(item.calls),
		fmtInt(item.totalTokens),
		fmtMoney(item.recordedCost),
		fmtMoney(totalCost(item)),
	].join(" | ");
}

const GRID_COLS = 11;
const GRID_ROWS = 8;
const GRID_CELLS = GRID_COLS * GRID_ROWS;

type TokenCell = "input" | "output" | "cacheRead" | "cacheWrite" | "empty";

function allocateCells(parts: Array<{ kind: TokenCell; value: number }>): TokenCell[] {
	const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
	if (total <= 0) return Array(GRID_CELLS).fill("empty");

	const cells: TokenCell[] = [];
	for (const part of parts) {
		let count = Math.round((Math.max(0, part.value) / total) * GRID_CELLS);
		if (part.value > 0 && count === 0) count = 1;
		for (let i = 0; i < count; i++) cells.push(part.kind);
	}

	while (cells.length < GRID_CELLS) cells.push("empty");
	while (cells.length > GRID_CELLS) cells.pop();
	return cells;
}

function cellSymbol(kind: TokenCell): string {
	switch (kind) {
		case "input":
			return "◍";
		case "output":
			return "○";
		case "cacheRead":
			return "●";
		case "cacheWrite":
			return "◌";
		case "empty":
			return "·";
	}
}

function colorCell(kind: TokenCell, theme: Theme): string {
	const symbol = cellSymbol(kind);
	switch (kind) {
		case "input":
			return theme.fg("accent", symbol);
		case "output":
			return theme.fg("warning", symbol);
		case "cacheRead":
			return theme.fg("success", symbol);
		case "cacheWrite":
			return theme.fg("muted", symbol);
		case "empty":
			return theme.fg("dim", symbol);
	}
}

function renderTokenGrid(totals: NumericTotals, theme: Theme): string[] {
	const cells = allocateCells([
		{ kind: "input", value: totals.input },
		{ kind: "output", value: totals.output },
		{ kind: "cacheRead", value: totals.cacheRead },
		{ kind: "cacheWrite", value: totals.cacheWrite },
	]);
	const lines: string[] = [];
	for (let rowIndex = 0; rowIndex < GRID_ROWS; rowIndex++) {
		const start = rowIndex * GRID_COLS;
		lines.push(cells.slice(start, start + GRID_COLS).map((kind) => colorCell(kind, theme)).join(" "));
	}
	return lines;
}

function renderBar(value: number, max: number, width: number, theme: Theme, color: "accent" | "success" | "warning" | "muted"): string {
	const safeMax = max > 0 ? max : 1;
	const filled = Math.max(0, Math.min(width, Math.round((value / safeMax) * width)));
	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function compactScope(result: ScanResult): string {
	if (result.mode === "all") return "all sessions";
	if (result.mode === "repo") return path.basename(result.repoRoot) || result.repoRoot;
	return path.basename(result.cwd) || result.cwd;
}

function tableLine(parts: string[], widths: number[]): string {
	return parts.map((part, index) => padAnsi(part, widths[index])).join("  ");
}

class SpendDashboard implements Component {
	constructor(private readonly result: ScanResult, private readonly theme: Theme) {}

	invalidate(): void {}

	private legendLine(symbol: string, label: string, value: string, pct: string, color: "accent" | "success" | "warning" | "muted" | "dim"): string {
		const th = this.theme;
		return `${th.fg(color, symbol)} ${padAnsi(`${label}:`, 17)} ${th.bold(value.padStart(9))} ${th.fg("muted", `(${pct})`)}`;
	}

	private sectionRows(title: string, rows: Array<TimeBucketTotals | ModelTotals>, maxRows: number): string[] {
		if (rows.length === 0) return [];
		const th = this.theme;
		const visible = rows.slice(0, maxRows);
		const max = Math.max(...visible.map(totalCost), ...visible.map((row) => row.totalTokens / MILLION), 0.000001);
		const labelFor = (row: TimeBucketTotals | ModelTotals) =>
			"period" in row ? row.period : row.model === "*" ? row.provider : `${row.provider}/${row.model}`;
		const labelWidth = Math.min(26, Math.max(title.length, ...visible.map((row) => labelFor(row).length)));
		const lines = ["", th.bold(title)];
		for (const row of visible) {
			const label = labelFor(row);
			const score = totalCost(row) > 0 ? totalCost(row) : row.totalTokens / MILLION;
			lines.push(
				`${truncateToWidth(label, labelWidth).padEnd(labelWidth)}  ${renderBar(score, max, 14, th, totalCost(row) > 0 ? "success" : "accent")}  ${fmtMoney(totalCost(row)).padStart(8)}  ${fmtCompact(row.totalTokens).padStart(7)} tok`
			);
		}
		if (rows.length > maxRows) lines.push(th.fg("dim", `… ${rows.length - maxRows} more`));
		return lines;
	}

	render(width: number): string[] {
		const th = this.theme;
		const total = this.result.totals;
		const totalTokens = total.totalTokens || total.input + total.output + total.cacheRead + total.cacheWrite;
		const totalSpend = totalCost(total);
		const costMax = Math.max(total.recordedCost, total.estimatedCost, totalSpend, 0.000001);
		const lines: string[] = [];

		lines.push(th.bold("Pi Spend"));
		lines.push(th.fg("dim", this.result.mode === "cwd" ? `Exact cwd: ${this.result.cwd}` : this.result.mode === "all" ? "All Pi sessions" : `Repo: ${this.result.repoRoot}`));
		lines.push("");
		lines.push(...renderTokenGrid(total, th));
		lines.push("");
		lines.push(`${th.fg("muted", compactScope(this.result))}   ${th.bold(fmtMoney(totalSpend))} / ${th.bold(fmtCompact(totalTokens))} tokens`);
		lines.push("");
		lines.push(this.legendLine("◍", "Input", fmtCompact(total.input), percent(total.input, totalTokens), "accent"));
		lines.push(this.legendLine("○", "Output", fmtCompact(total.output), percent(total.output, totalTokens), "warning"));
		lines.push(this.legendLine("●", "Cache read", fmtCompact(total.cacheRead), percent(total.cacheRead, totalTokens), "success"));
		lines.push(this.legendLine("◌", "Cache write", fmtCompact(total.cacheWrite), percent(total.cacheWrite, totalTokens), "muted"));
		lines.push("");
		lines.push(`${th.fg("success", "●")} ${padAnsi("Recorded:", 17)} ${renderBar(total.recordedCost, costMax, 14, th, "success")} ${th.bold(fmtMoney(total.recordedCost))}`);
		lines.push(`${th.fg("warning", "○")} ${padAnsi("Ollama estimate:", 17)} ${renderBar(total.estimatedCost, costMax, 14, th, "warning")} ${th.bold(fmtMoney(total.estimatedCost))}`);
		lines.push("");
		lines.push(tableLine([th.fg("accent", "Sessions"), th.fg("accent", "Calls"), th.fg("accent", "Providers"), th.fg("accent", "Models")], [10, 8, 10, 8]));
		lines.push(tableLine([fmtInt(this.result.filesIncluded), fmtInt(total.calls), fmtInt(this.result.byProvider.length), fmtInt(this.result.byModel.length)], [10, 8, 10, 8]));

		if (this.result.mode === "cwd") {
			lines.push(...this.sectionRows("By day", this.result.byDay, 7));
			lines.push(...this.sectionRows("By month", this.result.byMonth, 6));
		}
		lines.push(...this.sectionRows("Top providers", this.result.byProvider, 5));
		lines.push(...this.sectionRows("Top models", this.result.byModel, 5));
		lines.push("");
		lines.push(th.fg("dim", "Tip: use /repo-spend text for the copyable Markdown table."));

		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}

function renderReport(result: ScanResult): string {
	const total = result.totals;
	const scope =
		result.mode === "all"
			? "All Pi sessions"
			: result.mode === "cwd"
				? `Exact cwd: \`${result.cwd}\``
				: `Repo: \`${result.repoRoot}\``;

	const lines: string[] = [];
	lines.push(`# Pi repo spend`);
	lines.push("");
	lines.push(`**Scope:** ${scope}`);
	lines.push(`**Session root:** \`${result.sessionRoot}\``);
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|---|---:|");
	lines.push(row("Session files scanned", fmtInt(result.filesScanned)));
	lines.push(row("Session files included", fmtInt(result.filesIncluded)));
	lines.push(row("Assistant calls with usage", fmtInt(total.calls)));
	lines.push(row("Input tokens", fmtInt(total.input)));
	lines.push(row("Output tokens", fmtInt(total.output)));
	lines.push(row("Cache read tokens", fmtInt(total.cacheRead)));
	lines.push(row("Cache write tokens", fmtInt(total.cacheWrite)));
	lines.push(row("Total tokens", fmtInt(total.totalTokens)));
	lines.push(row("Recorded cost", fmtMoney(total.recordedCost)));
	lines.push(row("Estimated Ollama Cloud cost", fmtMoney(total.estimatedCost)));
	lines.push(row("Total cost", `**${fmtMoney(totalCost(total))}**`));
	lines.push(row("Oldest included session mtime", fmtDate(result.oldest)));
	lines.push(row("Newest included session mtime", fmtDate(result.newest)));
	if (result.parseErrors > 0) lines.push(row("Parse errors", fmtInt(result.parseErrors)));
	lines.push("");

	if (result.mode === "cwd" && result.byMonth.length > 0) {
		lines.push("## By month");
		lines.push("");
		lines.push("Month | Calls | Tokens | Recorded | Total");
		lines.push("---|---:|---:|---:|---:");
		for (const item of result.byMonth) lines.push(timeBucketRow(item));
		lines.push("");
	}

	if (result.mode === "cwd" && result.byDay.length > 0) {
		lines.push("## By day");
		lines.push("");
		lines.push("Day | Calls | Tokens | Recorded | Total");
		lines.push("---|---:|---:|---:|---:");
		for (const item of result.byDay) lines.push(timeBucketRow(item));
		lines.push("");
	}

	if (result.mode === "all" && result.byRepo.length > 0) {
		lines.push("## By repo / cwd");
		lines.push("");
		lines.push("Repo / cwd | Sessions | Calls | Tokens | Recorded | Ollama estimate | Total | Top model");
		lines.push("---|---:|---:|---:|---:|---:|---:|---");
		for (const item of result.byRepo) lines.push(repoRow(item));
		lines.push("");
	}

	if (result.byProvider.length > 0) {
		lines.push("## By provider");
		lines.push("");
		lines.push("Provider | Calls | Tokens | Recorded | Ollama estimate | Total");
		lines.push("---|---:|---:|---:|---:|---:");
		for (const item of result.byProvider) lines.push(providerRow(item));
		lines.push("");
	}

	if (result.byModel.length > 0) {
		lines.push("## By model");
		lines.push("");
		lines.push("Model | Calls | Tokens | Input | Output | Cache read | Recorded | Estimate | Total");
		lines.push("---|---:|---:|---:|---:|---:|---:|---:|---:");
		for (const item of result.byModel) lines.push(modelRow(item));
		lines.push("");
	}

	const estimatedModels = result.byModel.filter((item) => item.estimatedCost > 0 && item.pricingSource);
	if (estimatedModels.length > 0) {
		lines.push("## Ollama Cloud pricing notes");
		lines.push("");
		lines.push("> Ollama Cloud bills by subscription/cloud usage rather than fixed per-token rates. These rows are estimates using equivalent provider API pricing.");
		lines.push("");
		for (const item of estimatedModels) {
			lines.push(`- \`${item.model}\`: ${item.pricingSource}`);
		}
		lines.push("");
	}

	if (result.filesIncluded === 0) {
		lines.push("No matching Pi session files found for this scope.");
		lines.push("");
		lines.push("Try `/repo-spend all` to scan every session folder.");
	}

	return lines.join("\n");
}

function parseArgs(args: string): ParsedArgs {
	const parsed: ParsedArgs = { mode: "cwd", view: "dashboard" };
	for (const raw of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
		if (raw === "all" || raw === "--all") parsed.mode = "all";
		else if (raw === "repo" || raw === "--repo") parsed.mode = "repo";
		else if (raw === "cwd" || raw === "--cwd" || raw === "exact" || raw === "--exact") parsed.mode = "cwd";
		else if (raw === "text" || raw === "markdown" || raw === "md" || raw === "--text") parsed.view = "text";
		else if (raw === "dashboard" || raw === "dash" || raw === "graph" || raw === "graphical" || raw === "--dashboard") parsed.view = "dashboard";
	}
	return parsed;
}

function contentToString(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block?.type === "text") return block.text ?? "";
				return "";
			})
			.join("\n");
	}
	return String(content ?? "");
}

function clearStatus(ctx: any) {
	if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
}

export default function repoSpendExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(EXTENSION_ID, (message, _options, theme) => {
		const details = message.details as { result?: ScanResult; view?: ReportView } | undefined;
		if (details?.result && details.view !== "text") return new SpendDashboard(details.result, theme);
		return new Markdown(contentToString(message.content), 0, 0, getMarkdownTheme());
	});

	pi.on("session_start", async (_event, ctx) => {
		clearStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearStatus(ctx);
	});

	pi.registerCommand(COMMAND, {
		description: "Show graphical token/cost spend for this cwd, including daily/monthly breakdowns and estimated Ollama Cloud spend",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "all", label: "all", description: "Scan all Pi sessions" },
				{ value: "cwd", label: "cwd", description: "Only sessions with exactly this cwd" },
				{ value: "repo", label: "repo", description: "Sessions in the current git repo" },
				{ value: "text", label: "text", description: "Render the copyable Markdown report" },
				{ value: "dashboard", label: "dashboard", description: "Render the graphical dashboard" },
			];
			const filtered = options.filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const { mode, view } = parseArgs(args);
			ctx.ui.notify("Calculating Pi spend...", "info");
			const result = await scanSpend(pi, ctx.cwd, mode);
			const report = renderReport(result);

			pi.sendMessage({
				customType: EXTENSION_ID,
				content: report,
				display: true,
				details: { result, view },
			});

			ctx.ui.setStatus(EXTENSION_ID, undefined);
		},
	});
}
