import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
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

type ScanMode = "repo" | "all" | "cwd";

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

async function readSessionHeader(file: string): Promise<{ cwd?: string; timestamp?: string } | undefined> {
	const text = await readFile(file, "utf8");
	const firstLine = text.split("\n", 1)[0];
	if (!firstLine?.trim()) return undefined;
	const header = JSON.parse(firstLine);
	if (header?.type !== "session") return undefined;
	return { cwd: header.cwd, timestamp: header.timestamp };
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

async function scanSpend(pi: ExtensionAPI, cwd: string, mode: ScanMode): Promise<ScanResult> {
	const root = sessionRoot();
	const repoRoot = await getRepoRoot(pi, cwd);
	const files = await listJsonlFiles(root);
	const totals = blankTotals();
	const byModelMap = new Map<string, ModelTotals>();
	const byProviderMap = new Map<string, ModelTotals>();
	const byRepoMap = new Map<string, RepoAccumulator>();
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
		if (fileStat) {
			const mtime = fileStat.mtime.toISOString();
			if (!oldest || mtime < oldest) oldest = mtime;
			if (!newest || mtime > newest) newest = mtime;
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

function parseMode(args: string): ScanMode {
	const arg = args.trim().toLowerCase();
	if (arg === "all" || arg === "--all") return "all";
	if (arg === "cwd" || arg === "--cwd" || arg === "exact" || arg === "--exact") return "cwd";
	return "repo";
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
	pi.registerMessageRenderer(EXTENSION_ID, (message, _options, _theme) => {
		return new Markdown(contentToString(message.content), 0, 0, getMarkdownTheme());
	});

	pi.on("session_start", async (_event, ctx) => {
		clearStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearStatus(ctx);
	});

	pi.registerCommand(COMMAND, {
		description: "Show token usage and cost for this repo, including estimated Ollama Cloud spend",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "all", label: "all", description: "Scan all Pi sessions" },
				{ value: "cwd", label: "cwd", description: "Only sessions with exactly this cwd" },
			];
			const filtered = options.filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const mode = parseMode(args);
			ctx.ui.notify("Calculating Pi spend...", "info");
			const result = await scanSpend(pi, ctx.cwd, mode);
			const report = renderReport(result);

			pi.sendMessage({
				customType: EXTENSION_ID,
				content: report,
				display: true,
				details: result,
			});

			ctx.ui.setStatus(EXTENSION_ID, undefined);
		},
	});
}
