// ---------------------------------------------------------------------------
// /ssh doctor: read-only diagnostics for local SSH config and pi-owned sockets
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SshTarget } from "./types";
import { checkControlSocket, listPiSshSockets } from "./ssh/sweep";
import { runSsh, sshFailureMessage } from "./ssh/transport";
import { shQuote } from "./utils";

export interface IncludeDirective {
	line: number;
	value: string;
}

export interface ControlMasterBlock {
	kind: "global" | "host" | "match";
	line: number;
	selector: string;
	patterns: string[];
	controlMaster?: string;
	controlMasterLine?: number;
	controlPath?: string;
	controlPathLine?: number;
	controlPersist?: string;
	controlPersistLine?: number;
}

export interface ParsedControlMasterConfig {
	includes: IncludeDirective[];
	blocks: ControlMasterBlock[];
}

export interface LocalSshConfigReport extends ParsedControlMasterConfig {
	path: string;
	exists: boolean;
	readError?: string;
}

export interface LocalControlMasterDetection {
	path: string;
	hasGlobalControlMaster: boolean;
}

export interface DoctorSocket {
	path: string;
	current: boolean;
	state: "live" | "dead" | "missing" | "error";
	mtimeMs?: number;
	error?: string;
}

export interface ResolvedSshConfig {
	user?: string;
	hostname?: string;
	port?: string;
	controlMaster?: string;
	controlPath?: string;
	controlPersist?: string;
}

export interface UserControlMasterReport {
	config?: ResolvedSshConfig;
	state: "live" | "dead" | "not-configured" | "error";
	exitCommand: string;
	error?: string;
}

export interface DoctorReport {
	config: LocalSshConfigReport;
	sockets: DoctorSocket[];
	userControlMaster?: UserControlMasterReport;
	target?: SshTarget | null;
}

export function defaultSshConfigPath(): string {
	return join(homedir(), ".ssh", "config");
}

function stripComment(line: string): string {
	const match = line.match(/(^|\s)#/);
	return (match ? line.slice(0, match.index) : line).trim();
}

function hasControlSetting(block: ControlMasterBlock): boolean {
	return !!(block.controlMaster || block.controlPath || block.controlPersist);
}

function activeControlMaster(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized !== "no" && normalized !== "false" && normalized !== "none";
}

function commandArg(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : shQuote(value);
}

export function formatSshExitCommand(t: SshTarget): string {
	return ["ssh", "-O", "exit", ...t.sshOptions, t.remote].map(commandArg).join(" ");
}

export function parseControlMasterBlocks(configText: string): ParsedControlMasterConfig {
	const includes: IncludeDirective[] = [];
	const blocks: ControlMasterBlock[] = [];
	let current: ControlMasterBlock | null = null;

	const startBlock = (kind: ControlMasterBlock["kind"], line: number, selector: string): ControlMasterBlock => {
		const patterns = selector ? selector.split(/\s+/).filter(Boolean) : ["*"];
		current = { kind, line, selector, patterns };
		blocks.push(current);
		return current;
	};

	const currentBlock = (line: number): ControlMasterBlock => current ?? startBlock("global", line, "");

	configText.split(/\r?\n/).forEach((raw, idx) => {
		const line = idx + 1;
		const stripped = stripComment(raw);
		if (!stripped) return;
		const match = stripped.match(/^(\S+)(?:\s+(.*))?$/);
		if (!match) return;
		const keyword = match[1].toLowerCase();
		const value = (match[2] ?? "").trim();
		if (keyword === "host") {
			startBlock("host", line, value);
			return;
		}
		if (keyword === "match") {
			startBlock("match", line, value);
			return;
		}
		if (keyword === "include") {
			includes.push({ line, value });
			return;
		}
		if (keyword === "controlmaster") {
			const block = currentBlock(line);
			block.controlMaster = value;
			block.controlMasterLine = line;
			return;
		}
		if (keyword === "controlpath") {
			const block = currentBlock(line);
			block.controlPath = value;
			block.controlPathLine = line;
			return;
		}
		if (keyword === "controlpersist") {
			const block = currentBlock(line);
			block.controlPersist = value;
			block.controlPersistLine = line;
		}
	});

	return { includes, blocks: blocks.filter(hasControlSetting) };
}

export function globalControlMasterBlocks(config: ParsedControlMasterConfig): ControlMasterBlock[] {
	return config.blocks.filter((block) => {
		if (!activeControlMaster(block.controlMaster)) return false;
		if (block.kind === "global") return true;
		return block.kind === "host" && block.patterns.length === 1 && block.patterns[0] === "*";
	});
}

export function parseSshGOutput(stdout: string): ResolvedSshConfig {
	const config: ResolvedSshConfig = {};
	for (const line of stdout.split(/\r?\n/)) {
		const match = line.match(/^(\S+)\s+(.*)$/);
		if (!match) continue;
		const key = match[1].toLowerCase();
		const value = match[2].trim();
		if (key === "user") config.user = value;
		else if (key === "hostname") config.hostname = value;
		else if (key === "port") config.port = value;
		else if (key === "controlmaster") config.controlMaster = value;
		else if (key === "controlpath") config.controlPath = value;
		else if (key === "controlpersist") config.controlPersist = value;
	}
	return config;
}

export async function inspectUserControlMaster(
	t: SshTarget,
	opts: {
		runSshG?: () => Promise<{ code: number | null; stdout: Buffer; stderr: Buffer; timedOut: boolean; signal: NodeJS.Signals | null }>;
		checkFn?: (socket: string) => Promise<boolean>;
	} = {},
): Promise<UserControlMasterReport> {
	const exitCommand = formatSshExitCommand(t);
	const runSshG = opts.runSshG ?? (() => runSsh(["-G", ...t.sshOptions, "--", t.remote], { timeout: 10 }));
	const checkFn = opts.checkFn ?? checkControlSocket;
	let resolved: ResolvedSshConfig;
	try {
		const r = await runSshG();
		if (r.code !== 0 || r.timedOut || r.signal) {
			return { state: "error", exitCommand, error: `${sshFailureMessage(r)}: ${r.stderr.toString().trim() || r.stdout.toString().trim()}` };
		}
		resolved = parseSshGOutput(r.stdout.toString());
	} catch (e) {
		return { state: "error", exitCommand, error: e instanceof Error ? e.message : String(e) };
	}
	const controlPath = resolved.controlPath;
	if (!activeControlMaster(resolved.controlMaster) || !controlPath || controlPath === "none") {
		return { config: resolved, state: "not-configured", exitCommand };
	}
	try {
		const live = await checkFn(controlPath);
		return { config: resolved, state: live ? "live" : "dead", exitCommand };
	} catch (e) {
		return { config: resolved, state: "error", exitCommand, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function readLocalSshConfig(configPath = defaultSshConfigPath()): Promise<LocalSshConfigReport> {
	try {
		const raw = await readFile(configPath, "utf8");
		return { path: configPath, exists: true, ...parseControlMasterBlocks(raw) };
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { path: configPath, exists: false, includes: [], blocks: [] };
		return { path: configPath, exists: false, readError: err.message, includes: [], blocks: [] };
	}
}

export function detectLocalGlobalControlMaster(configPath = defaultSshConfigPath()): LocalControlMasterDetection {
	try {
		const parsed = parseControlMasterBlocks(readFileSync(configPath, "utf8"));
		return { path: configPath, hasGlobalControlMaster: globalControlMasterBlocks(parsed).length > 0 };
	} catch {
		return { path: configPath, hasGlobalControlMaster: false };
	}
}

export async function inspectPiSockets(currentSocket?: string): Promise<DoctorSocket[]> {
	const missingCurrent: DoctorSocket[] = [];
	let entries = await listPiSshSockets().catch(() => []);
	if (currentSocket && !entries.some((entry) => entry.path === currentSocket)) {
		try {
			const st = await stat(currentSocket);
			if (st.isSocket()) {
				entries = [{ path: currentSocket, mtimeMs: st.mtimeMs }, ...entries];
			} else {
				missingCurrent.push({ path: currentSocket, current: true, state: "missing" });
			}
		} catch {
			missingCurrent.push({ path: currentSocket, current: true, state: "missing" });
		}
	}

	const seen = new Set<string>();
	const unique = entries
		.filter((entry) => {
			if (seen.has(entry.path)) return false;
			seen.add(entry.path);
			return true;
		})
		.sort((a, b) => {
			if (a.path === currentSocket) return -1;
			if (b.path === currentSocket) return 1;
			return a.path.localeCompare(b.path);
		});

	const checked = await Promise.all(unique.map(async (entry): Promise<DoctorSocket> => {
		try {
			const live = await checkControlSocket(entry.path);
			return { path: entry.path, current: entry.path === currentSocket, state: live ? "live" : "dead", mtimeMs: entry.mtimeMs };
		} catch (e) {
			return { path: entry.path, current: entry.path === currentSocket, state: "error", mtimeMs: entry.mtimeMs, error: e instanceof Error ? e.message : String(e) };
		}
	}));
	return [...missingCurrent, ...checked];
}

export async function checkPiControlMaster(t: SshTarget): Promise<DoctorSocket["state"]> {
	try {
		return await checkControlSocket(t.socket) ? "live" : "dead";
	} catch {
		return "error";
	}
}

function formatBlock(block: ControlMasterBlock): string {
	const selector = block.kind === "global" ? "global preamble" : `${block.kind === "host" ? "Host" : "Match"} ${block.selector}`;
	const parts = [
		`ControlMaster=${block.controlMaster ?? "-"}`,
		`ControlPath=${block.controlPath ?? "-"}`,
		`ControlPersist=${block.controlPersist ?? "-"}`,
	];
	return `line ${block.line} ${selector}: ${parts.join(" ")}`;
}

export function formatDoctorReport(report: DoctorReport): string {
	const { config, sockets, target, userControlMaster } = report;
	const lines: string[] = ["SSH doctor"];
	lines.push(target ? `Connection: ${target.remote}:${target.remoteCwd}` : "Connection: not connected");
	if (target) {
		lines.push(`Shell: ${target.shellKind} (${target.loginShell})${target.shellNote ? ` - ${target.shellNote}` : ""}`);
		lines.push(`Login env: ${target.loginEnvDirty ? "stale; run /ssh reconnect or ssh_connect fresh:true" : "fresh"}`);
	}

	lines.push("");
	lines.push(`Local SSH config: ${config.path}`);
	if (config.readError) {
		lines.push(`  read failed: ${config.readError}`);
	} else if (!config.exists) {
		lines.push("  missing; no local ControlMaster config detected.");
	} else {
		const globals = globalControlMasterBlocks(config);
		if (globals.length) {
			lines.push("  Global ControlMaster: detected");
			for (const block of globals) lines.push(`  - ${formatBlock(block)}`);
			lines.push("  Your terminal ssh may reuse its own ControlMaster socket independently of pi.");
			if (target) lines.push("  See the resolved ssh -G section below for the exact terminal master refresh command.");
			lines.push("  pi uses private /tmp/pi-ssh-*.sock sockets and never writes ~/.ssh/config.");
		} else {
			lines.push("  Global ControlMaster: not detected in this file.");
		}
		const other = config.blocks.filter((block) => !globals.includes(block));
		if (other.length) {
			lines.push("  Other ControlMaster settings:");
			for (const block of other) lines.push(`  - ${formatBlock(block)}`);
		}
		if (config.includes.length) {
			lines.push(`  Include directives not followed: ${config.includes.map((inc) => `line ${inc.line} ${inc.value}`).join("; ")}`);
		}
	}

	lines.push("");
	lines.push("Resolved terminal SSH mux (ssh -G):");
	if (!target) {
		lines.push("  not checked; not connected.");
	} else if (!userControlMaster) {
		lines.push("  not checked.");
	} else if (!userControlMaster.config) {
		lines.push(`  ssh -G failed: ${userControlMaster.error ?? "unknown error"}`);
		lines.push(`  Refresh command if a terminal master exists: ${userControlMaster.exitCommand}`);
	} else {
		const cfg = userControlMaster.config;
		lines.push(`  user=${cfg.user ?? "-"} hostname=${cfg.hostname ?? "-"} port=${cfg.port ?? "-"}`);
		lines.push(`  ControlMaster=${cfg.controlMaster ?? "-"} ControlPath=${cfg.controlPath ?? "-"} ControlPersist=${cfg.controlPersist ?? "-"}`);
		if (userControlMaster.state === "not-configured") {
			lines.push("  No user-side ControlMaster is enabled for this target.");
		} else {
			const extra = userControlMaster.error ? ` (${userControlMaster.error})` : "";
			lines.push(`  User-side master: ${userControlMaster.state}${extra}`);
			lines.push(`  Refresh command: ${userControlMaster.exitCommand}`);
		}
	}

	lines.push("");
	lines.push("pi ControlMaster sockets:");
	if (!sockets.length) {
		lines.push("  none found");
	} else {
		for (const socket of sockets) {
			const mark = socket.current ? "*" : "-";
			const extra = socket.error ? ` (${socket.error})` : "";
			lines.push(`  ${mark} ${socket.state.padEnd(7)} ${socket.path}${extra}`);
		}
	}
	return lines.join("\n");
}

export async function runSshDoctor(target?: SshTarget | null): Promise<string> {
	const [config, sockets, userControlMaster] = await Promise.all([
		readLocalSshConfig(),
		inspectPiSockets(target?.socket),
		target ? inspectUserControlMaster(target) : Promise.resolve(undefined),
	]);
	return formatDoctorReport({ config, sockets, userControlMaster, target });
}
