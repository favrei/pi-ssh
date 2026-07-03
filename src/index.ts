/**
 * SSH Remote Execution Extension (enhanced)
 *
 * Adds explicit ssh_read/ssh_write/ssh_edit/ssh_bash tools for remote
 * operations via SSH. Local read/write/edit/bash tools remain local, so the
 * common workflow of editing locally and testing remotely stays unambiguous.
 *
 * Connect at runtime:
 *   /ssh user@host                                      # use remote pwd as cwd
 *   /ssh user@host:/remote/path                         # explicit remote cwd
 *   /ssh -i /path/to/key.pem root@host                  # identity file / ssh options
 *   /ssh -i key root@host:/path --activate 'source .venv/bin/activate'
 *   /ssh root@host --env PYTHONPATH=/src --env CUDA_VISIBLE_DEVICES=0
 *   /ssh --fresh root@host                             # close old mux first; fresh login state
 *   /ssh reconnect                                     # hard reconnect current target
 *   /ssh off                                           # disconnect
 *   /ssh                                               # show current status
 *
 * --activate <cmd> and --env KEY=VALUE (repeatable) attach a persistent shell
 * prefix / environment that is applied to EVERY ssh_bash and ssh_process run,
 * so you do not have to re-source a venv or re-export vars on each call.
 *
 * Agents can also call ssh_connect/ssh_disconnect/ssh_status directly; pass
 * fresh:true to ssh_connect after remote group/PAM/login-state changes.
 *
 * Or at startup:
 *   pi -e ./ssh/index.ts --ssh "-i /path/to/key.pem root@host[:/path]"
 *
 * Enhancements over the bundled example:
 *   1. SSH connection reuse via OpenSSH ControlMaster multiplexing — all
 *      ssh invocations share one persistent master connection, so no
 *      repeated auth/TCP handshake per tool call.
 *   2. Real remote in-place edit — oldText/newText are shipped to the remote
 *      and applied by python3 there; only the diff comes back. Falls back to
 *      read-rewrite-write when python3 is unavailable on the remote.
 *   3. Persistent per-connection activation/env (--activate / --env) applied
 *      to ssh_bash and ssh_process so venv/env setup is not repeated.
 *   4. Background remote processes (ssh_process) capture their exit code and
 *      support a clear action to prune finished jobs.
 *
 * Requirements:
 *   - SSH key-based auth (BatchMode=yes; no password prompts)
 *   - bash on remote; python3 on remote for efficient in-place edit
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Activation, ShellMode, SshTarget } from "./types";
import { buildEnvExports, shQuote, toRemotePath } from "./utils";
import { setReconnectNotifier } from "./ssh/reconnect";
import { closeMaster, isRetryableSshFailure, remoteShell, runRemoteCommand, runSsh, setMasterRecycledNotifier, sshConnArgs, sshFailureMessage } from "./ssh/transport";
import { resolveTarget } from "./ssh/target";
import { sendProcessMessage } from "./notify";
import { createRender } from "./render";
import type { SshContext } from "./context";
import { createTunnelManager, type TunnelManager } from "./tunnels";
import { createSyncManager, type SyncManager } from "./sync";
import { setupConnectionTools } from "./tools/connection";
import { setupFsTools } from "./tools/fs";
import { setupBashTool } from "./tools/bash";
import { setupProcessTool } from "./tools/process";
import { setupMonitorTool } from "./tools/monitor";
import { setupTransferTools } from "./tools/transfer";
import { setupHooks } from "./hooks";
import { setupDashboard } from "./dashboard";
import { detectLocalGlobalControlMaster } from "./doctor";
import { createPollerManager } from "./poller";
import { createMonitorManager } from "./monitor";
import {
	listProcesses,
} from "./process-queries";


// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote, e.g. user@host[:/path], -i key user@host, optionally with --activate <cmd> / --env K=V", type: "string" });

	const localCwd = process.cwd();

	// Background ssh_process notification poller (owns pollers + latestStartByName).
	const poller = createPollerManager(pi);
	// Runtime-managed log monitors (decoupled from ssh_process; owns its own store).
	const monitors = createMonitorManager(pi);
	// Agent-facing notification sink shared by the poller and the sync watcher.
	const emit = (content: string, details: Record<string, unknown>): void => sendProcessMessage(pi, content, details);

	let target: SshTarget | null = null;
	const get = () => target;

	function statusLabel(t: SshTarget | null): string {
		if (!t) return "";
		const act = t.defaultCommandPrefix ? ` ⚡${t.defaultCommandPrefix.length > 28 ? `${t.defaultCommandPrefix.slice(0, 27)}…` : t.defaultCommandPrefix}` : "";
		const dirty = t.loginEnvDirty ? " ⟳ env stale" : "";
		return `SSH: ${t.remote}:${t.remoteCwd}${t.hasPython ? "" : " (no python3)"}${act}${dirty}`;
	}

	// Last seen ui handle, captured from any ctx, so the connection-level footer
	// heartbeat can update status/widgets without a live command/tool ctx.
	let uiRef: { setStatus: (k: string, v?: string) => void; setWidget: (k: string, v?: unknown, o?: unknown) => void; notify: (msg: string, type?: "info" | "warning" | "error") => void; theme: { fg: (c: string, s: string) => string } } | null = null;
	let widgetTimer: NodeJS.Timeout | null = null;
	const HEARTBEAT_POLL_MS = 2000;
	const HEARTBEAT_TIMEOUT_S = 3;
	const PROCESS_WIDGET_POLL_MS = 5000;
	let heartbeatState: "online" | "offline" | "unknown" = "unknown";
	let heartbeatFailures = 0;
	let heartbeatLastError = "";
	let lastProcessWidgetAt = 0;
	let lastProcessWidgetParts: string[] = [];
	let reconnectStatusActive = false;
	let heartbeatRecycle: Promise<void> | null = null;

	function stopWidgetPoller(): void {
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = null;
		}
		heartbeatState = "unknown";
		heartbeatFailures = 0;
		heartbeatLastError = "";
		reconnectStatusActive = false;
		lastProcessWidgetAt = 0;
		lastProcessWidgetParts = [];
		heartbeatRecycle = null;
		uiRef?.setWidget("ssh-procs", undefined);
	}

	function resetHeartbeatOnline(): void {
		heartbeatState = target ? "online" : "unknown";
		heartbeatFailures = 0;
		heartbeatLastError = "";
		heartbeatRecycle = null;
	}

	function renderSshStatus(): void {
		if (!uiRef) return;
		const label = statusLabel(target);
		if (!label) {
			uiRef.setStatus("ssh", "");
			return;
		}
		if (heartbeatState === "offline") {
			uiRef.setStatus("ssh", uiRef.theme.fg("warning", `${label} — offline (heartbeat failed; tunnels may be down)`));
			return;
		}
		uiRef.setStatus("ssh", uiRef.theme.fg("accent", label));
	}

	async function heartbeatProbe(t: SshTarget): Promise<{ ok: boolean; error?: string; recycleMaster?: boolean }> {
		try {
			const r = await runSsh([...sshConnArgs(t), remoteShell(t, "true", false)], { timeout: HEARTBEAT_TIMEOUT_S });
			if (r.code === 0 && !r.signal && !r.timedOut) return { ok: true };
			const msg = r.stderr.toString().trim() || r.stdout.toString().trim() || sshFailureMessage(r);
			return { ok: false, error: msg.split(/\r?\n/)[0], recycleMaster: r.timedOut || isRetryableSshFailure(r) };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e), recycleMaster: true };
		}
	}

	function recycleHeartbeatMaster(t: SshTarget): void {
		if (heartbeatRecycle) return;
		heartbeatRecycle = closeMaster(t, { reason: "retry" }).catch(() => {}).finally(() => {
			if (target === t) heartbeatRecycle = null;
		});
	}

	function renderWidget(parts: string[]): void {
		if (!uiRef) return;
		const tunnelCount = ctx.tunnels?.list().length ?? 0;
		const merged = [...parts];
		if (tunnelCount > 0 && !merged.some((p) => /tunnels?$/.test(p))) merged.push(`${tunnelCount} tunnel${tunnelCount === 1 ? "" : "s"}`);
		if (heartbeatState === "offline") {
			const text = merged.length ? `ssh offline: ${merged.join(" \u00b7 ")}` : "ssh offline";
			uiRef.setWidget("ssh-procs", [uiRef.theme.fg("warning", text)]);
			return;
		}
		uiRef.setWidget("ssh-procs", merged.length ? [uiRef.theme.fg("accent", `ssh: ${merged.join(" \u00b7 ")}`)] : undefined);
	}

	function startWidgetPoller(): void {
		if (widgetTimer || !uiRef) return;
		let busy = false;
		const tickWidget = async () => {
			if (busy || !target || !uiRef) return;
			busy = true;
			const checkedTarget = target;
			try {
				if (!reconnectStatusActive && !heartbeatRecycle) {
					const wasOffline = heartbeatState === "offline";
					const hb = await heartbeatProbe(checkedTarget);
					if (target !== checkedTarget) return;
					if (hb.ok) {
						heartbeatFailures = 0;
						heartbeatLastError = "";
						heartbeatState = "online";
						if (wasOffline) {
							uiRef.notify(`SSH heartbeat recovered: ${checkedTarget.remote}`, "info");
							scheduleTunnelRestore(checkedTarget.socket);
						}
					} else {
						heartbeatFailures++;
						heartbeatLastError = hb.error ?? "heartbeat failed";
						if (heartbeatState !== "offline") {
							heartbeatState = "offline";
							uiRef.notify(`SSH heartbeat lost: ${checkedTarget.remote}${heartbeatLastError ? ` (${heartbeatLastError})` : ""}`, "warning");
						}
						if (hb.recycleMaster) recycleHeartbeatMaster(checkedTarget);
					}
					renderSshStatus();
				} else if (heartbeatRecycle) {
					renderSshStatus();
				}

				if (heartbeatState !== "offline" && Date.now() - lastProcessWidgetAt >= PROCESS_WIDGET_POLL_MS) {
					const rows = await listProcesses(checkedTarget);
					if (target !== checkedTarget) return;
					const running = rows.filter((r) => r.status === "running").length;
					lastProcessWidgetParts = running > 0 ? [`${running} running`] : [];
					lastProcessWidgetAt = Date.now();
				}
				renderWidget(lastProcessWidgetParts);
			} catch {
				/* transient: heartbeat owns offline state; keep the last widget value */
			} finally {
				busy = false;
			}
		};
		widgetTimer = setInterval(() => void tickWidget(), HEARTBEAT_POLL_MS);
		widgetTimer.unref?.();
		void tickWidget();
	}

	function refreshStatus(ctx: any) {
		if (ctx?.ui) uiRef = ctx.ui;
		if (!reconnectStatusActive) renderSshStatus();
		// Drive the heartbeat/process widget by connection state.
		if (target && uiRef) startWidgetPoller();
		else stopWidgetPoller();
	}

	function clearLoginEnvDirty(socket?: string): void {
		if (!target || (socket && target.socket !== socket)) return;
		if (!target.loginEnvDirty) return;
		target.loginEnvDirty = false;
		refreshStatus(null);
	}

	function annotateLocalSshConfig(t: SshTarget): void {
		t.localControlMasterDetected = detectLocalGlobalControlMaster().hasGlobalControlMaster;
	}

	let tunnelRestoreTimer: NodeJS.Timeout | null = null;
	let tunnelRestoreSocket: string | undefined;
	function scheduleTunnelRestore(socket?: string): void {
		if (socket && target?.socket !== socket) return;
		if (tunnelRestoreTimer) return;
		tunnelRestoreSocket = socket;
		tunnelRestoreTimer = setTimeout(() => {
			tunnelRestoreTimer = null;
			const expectedSocket = tunnelRestoreSocket;
			tunnelRestoreSocket = undefined;
			if (expectedSocket && target?.socket !== expectedSocket) return;
			if (!target) return;
			void ctx.tunnels?.restoreAll().then((res) => {
				if ((res.restored > 0 || res.failed > 0) && uiRef) {
					uiRef.notify(
						res.failed === 0
							? `SSH tunnels restored: ${res.restored}`
							: `SSH tunnels restored: ${res.restored}, failed: ${res.failed}`,
						res.failed === 0 ? "info" : "warning",
					);
				}
			}).catch(() => {});
		}, 2000);
		tunnelRestoreTimer.unref?.();
	}

	// Surface backoff-reconnection progress in the status line; notify on the outcome.
	// Reads uiRef/target lazily at call time, so a single assignment stays current.
	setReconnectNotifier((phase, info) => {
		if (phase === "retrying") {
			reconnectStatusActive = true;
			if (uiRef) {
				uiRef.setStatus("ssh", uiRef.theme.fg("warning", `Reconnecting ${info.remote} \u2014 attempt ${info.attempt}/${info.max}, retry in ${Math.round(info.delayMs / 1000)}s\u2026`));
			}
			return;
		}
		reconnectStatusActive = false;
		if (phase === "recovered") {
			resetHeartbeatOnline();
			clearLoginEnvDirty(target?.socket);
			renderSshStatus();
			uiRef?.notify(`SSH reconnected: ${info.remote}`, "info");
			// The respawned master lost its -L forwards; re-issue tracked tunnels.
			scheduleTunnelRestore(target?.socket);
		} else {
			heartbeatState = target ? "offline" : "unknown";
			heartbeatFailures = Math.max(heartbeatFailures, 1);
			heartbeatLastError = "reconnect failed";
			renderSshStatus();
			uiRef?.notify(`SSH reconnect to ${info.remote} failed after ${info.max} attempts`, "error");
		}
	});

	setMasterRecycledNotifier((info) => {
		if (target?.socket !== info.socket) return;
		resetHeartbeatOnline();
		clearLoginEnvDirty(info.socket);
		refreshStatus(null);
		scheduleTunnelRestore(info.socket);
	});

	function tokenizeSshArgs(input: string): string[] {
		const tokens: string[] = [];
		let current = "";
		let quote: "'" | '"' | undefined;
		let escaping = false;
		for (const ch of input) {
			if (escaping) {
				current += ch;
				escaping = false;
				continue;
			}
			if (ch === "\\" && quote !== "'") {
				escaping = true;
				continue;
			}
			if ((ch === "'" || ch === '"') && (!quote || quote === ch)) {
				quote = quote ? undefined : ch;
				continue;
			}
			if (!quote && /\s/.test(ch)) {
				if (current) {
					tokens.push(current);
					current = "";
				}
				continue;
			}
			current += ch;
		}
		if (quote) throw new Error("Unclosed quote in /ssh arguments");
		if (escaping) current += "\\";
		if (current) tokens.push(current);
		return tokens;
	}

	function parseConnectArg(arg: string): { remote: string; path?: string; sshOptions: string[]; activation: Activation; fresh: boolean; shellMode: ShellMode } {
		const tokens = tokenizeSshArgs(arg);
		if (tokens[0] === "ssh") tokens.shift();
		if (tokens.length === 0) throw new Error("Missing SSH destination");

		// Extract our own flags before treating the rest as ssh options + destination.
		// Values may be attached (--env=K=V) or separate. --fresh/--hard force a new
		// login session while keeping ControlMaster enabled for normal extension use.
		let commandPrefix: string | undefined;
		let fresh = false;
		let shellMode: ShellMode = "auto";
		const env: Record<string, string> = {};
		const rest: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const tk = tokens[i];
			if (tk === "--fresh" || tk === "--hard" || tk === "--hard-reconnect") {
				fresh = true;
				continue;
			}
			if (tk === "--no-controlmaster" || tk === "--no-control-master") {
				throw new Error("--no-controlmaster is not supported: pi SSH uses ControlMaster for tunnels, process polling, sync, and low-latency tools. Use --fresh/--hard to force a new login session while keeping multiplexing enabled.");
			}
			if (tk === "--shell" || tk.startsWith("--shell=")) {
				const value = tk.startsWith("--shell=") ? tk.slice("--shell=".length) : tokens[++i];
				if (value !== "auto" && value !== "bash" && value !== "zsh") throw new Error(`--shell expects auto, bash, or zsh; got: ${value ?? ""}`);
				shellMode = value;
				continue;
			}
			if (tk === "--activate") {
				commandPrefix = tokens[++i];
				if (commandPrefix === undefined) throw new Error("--activate requires a command, e.g. --activate 'source .venv/bin/activate'");
				continue;
			}
			if (tk.startsWith("--activate=")) {
				commandPrefix = tk.slice("--activate=".length);
				continue;
			}
			if (tk === "--env" || tk.startsWith("--env=")) {
				const kv = tk.startsWith("--env=") ? tk.slice("--env=".length) : tokens[++i];
				if (kv === undefined) throw new Error("--env requires KEY=VALUE");
				const eq = kv.indexOf("=");
				if (eq <= 0) throw new Error(`--env expects KEY=VALUE, got: ${kv}`);
				const key = kv.slice(0, eq);
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid env var name: ${key}`);
				env[key] = kv.slice(eq + 1);
				continue;
			}
			rest.push(tk);
		}
		if (rest.length === 0) throw new Error("Missing SSH destination");
		const destination = rest[rest.length - 1];
		const sshOptions = rest.slice(0, -1);
		for (let i = 0; i < sshOptions.length; i++) {
			const opt = sshOptions[i];
			const value = opt === "-o" ? (sshOptions[i + 1] ?? "") : opt.startsWith("-o") ? opt.slice(2) : "";
			if (opt === "-S" || opt.startsWith("-S") || opt === "-M" || opt.startsWith("-M") || /^Control(?:Master|Path|Persist)\b/i.test(value)) {
				throw new Error("pi SSH manages ControlMaster/ControlPath internally. Use --fresh/--hard to force a new login session instead of overriding mux options.");
			}
		}
		const activation: Activation = { commandPrefix, env: Object.keys(env).length ? env : undefined };
		const homePath = destination.match(/^(.+):(~(?:\/.*)?)$/);
		if (homePath) {
			throw new Error("SSH remote cwd must be an absolute path; use /ssh -i key user@host:/absolute/path");
		}
		const match = destination.match(/^(.+):(\/.*)$/);
		if (!match) {
			return { remote: destination, sshOptions, activation, fresh, shellMode };
		}
		return { remote: match[1], path: match[2], sshOptions, activation, fresh, shellMode };
	}

	// --- connection profiles (~/.pi/ssh-profiles.json) ---
	function profilesPath(): string {
		return join(homedir(), ".pi", "ssh-profiles.json");
	}

	function loadProfiles(): Record<string, string> {
		let raw: string;
		try {
			raw = readFileSync(profilesPath(), "utf8");
		} catch {
			return {}; // missing file is fine
		}
		// A corrupt file must NOT silently reset to {} (that would let `save`
		// clobber every existing entry). Surface it.
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			throw new Error(`Corrupt SSH profiles file ${profilesPath()}: ${e instanceof Error ? e.message : String(e)}`);
		}
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
	}

	function profileNames(): string[] {
		return Object.keys(loadProfiles()).sort();
	}

	// Expand a leading @name into the saved target string; trailing tokens override.
	function expandProfile(arg: string): string {
		const trimmed = arg.trim();
		if (!trimmed.startsWith("@")) return arg;
		const name = trimmed.slice(1).split(/\s+/)[0];
		if (!name) throw new Error("Missing profile name after @");
		const rest = trimmed.slice(1 + name.length).trim();
		const base = loadProfiles()[name];
		if (!base) throw new Error(`SSH profile not found: @${name} (define it in ${profilesPath()} or use /ssh save ${name})`);
		return rest ? `${base} ${rest}` : base;
	}

	function saveProfile(name: string): void {
		const t = requireTarget();
		if (!t.originArg) throw new Error("No connection string to save for the active SSH target");
		if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid profile name: ${name}`);
		const profiles = loadProfiles();
		profiles[name] = t.originArg;
		mkdirSync(dirname(profilesPath()), { recursive: true });
		writeFileSync(profilesPath(), `${JSON.stringify(profiles, null, 2)}\n`);
	}

	async function connect(arg: string): Promise<SshTarget> {
		const expanded = expandProfile(arg);
		const { remote, path, sshOptions, activation, shellMode } = parseConnectArg(expanded);
		const t = await resolveTarget(remote, path, sshOptions, activation, shellMode);
		annotateLocalSshConfig(t);
		t.originArg = expanded.trim();
		return t;
	}

	async function switchTarget(arg: string, options: { fresh?: boolean } = {}): Promise<SshTarget> {
		const expanded = expandProfile(arg);
		const parsed = parseConnectArg(expanded);
		const prev = target;
		const fresh = !!(options.fresh || parsed.fresh);
		if (fresh && prev) {
			// A hard reconnect must create a new remote login/PAM session. Close the
			// pi-owned mux before resolving the new target; the old master may carry
			// stale supplementary groups or login-time environment.
			await closeMaster(prev);
		}
		let next: SshTarget;
		try {
			next = await resolveTarget(parsed.remote, parsed.path, parsed.sshOptions, parsed.activation, parsed.shellMode);
			annotateLocalSshConfig(next);
		} catch (e) {
			if (fresh && prev) {
				// Keep the previous logical connection. Its mux was closed above, so warm
				// it back up before re-issuing tracked forwards.
				await runRemoteCommand(prev, "true", { login: false, timeout: 10 }).catch(() => {});
				await ctx.tunnels.restoreAll().catch(() => {});
				throw new Error(`hard reconnect failed; previous connection retained: ${e instanceof Error ? e.message : String(e)}`);
			}
			throw e;
		}
		next.originArg = expanded.trim();
		const sameTarget = !!prev && prev.remote === next.remote && prev.remoteCwd === next.remoteCwd;
		// Reconnecting to the SAME host+cwd (same .pi-ssh-processes registry): keep the
		// in-memory pollers/monitors and active tunnel registry, then repoint/re-issue
		// them against the new master. Different targets get a clean slate.
		if (sameTarget) {
			poller.repointAll(next);
			monitors.repointAll(next);
		} else {
			poller.stopAll();
			monitors.stopAll();
			if (prev) ctx.tunnels.stopAll();
		}
		if (prev && !fresh) await closeMaster(prev);
		target = next;
		resetHeartbeatOnline();
		if (sameTarget) await ctx.tunnels.restoreAll();
		await ctx.tunnels.restoreSaved(next);
		await poller.rehydrate(next);
		await monitors.rehydrate(next);
		return next;
	}

	async function disconnect(): Promise<void> {
		poller.stopAll();
		monitors.stopAll();
		ctx.sync.stop();
		if (target) {
			ctx.tunnels.stopAll();
			await closeMaster(target);
		}
		target = null;
		resetHeartbeatOnline();
	}


	function requireTarget(): SshTarget {
		if (!target) {
			throw new Error("SSH is not connected. Use /ssh [-i key] user@host or call ssh_connect first.");
		}
		return target;
	}

	function connectedText(t: SshTarget): string {
		const lines = [`SSH connected: ${t.remote}:${t.remoteCwd}${t.hasPython ? "" : " (no python3; ssh_edit uses fallback)"}`];
		lines.push(`  shell: ${t.shellKind} (${t.loginShell})${t.shellNote ? ` - ${t.shellNote}` : ""}`);
		if (t.loginEnvDirty) lines.push("  login env: stale; run /ssh reconnect or ssh_connect fresh:true");
		if (t.localControlMasterDetected) lines.push("  local ssh config: global ControlMaster detected; run /ssh doctor");
		if (t.defaultCommandPrefix) lines.push(`  activation (every ssh_bash/ssh_process): ${t.defaultCommandPrefix}`);
		if (t.defaultEnv && Object.keys(t.defaultEnv).length) lines.push(`  env: ${Object.keys(t.defaultEnv).join(", ")}`);
		const activeTunnels = ctx.tunnels?.list?.() ?? [];
		if (activeTunnels.length) {
			lines.push(`  tunnels: ${activeTunnels.map((x) => `localhost:${x.localPort}->${x.remoteHost}:${x.remotePort}${x.saved ? " [saved]" : ""}`).join(", ")}`);
		}
		return lines.join("\n");
	}

	function buildSshBashCommand(t: SshTarget, params: {
		command: string;
		cwd?: string;
		delaySeconds?: number;
		env?: Record<string, string>;
		commandPrefix?: string;
	}): string {
		// Order mirrors processRunScript: cd -> env -> activation -> per-call prefix -> command.
		const parts: string[] = [];
		if (params.cwd?.trim()) parts.push(`cd -- ${shQuote(toRemotePath(params.cwd, localCwd, t.remoteCwd, t.remoteHome))}`);
		parts.push(...buildEnvExports({ ...t.defaultEnv, ...params.env }));
		if (t.defaultCommandPrefix?.trim()) parts.push(t.defaultCommandPrefix);
		if (params.commandPrefix?.trim()) parts.push(params.commandPrefix);
		if (params.delaySeconds !== undefined) {
			if (!Number.isFinite(params.delaySeconds) || params.delaySeconds < 0) {
				throw new Error("ssh_bash delaySeconds must be a non-negative number");
			}
			if (params.delaySeconds > 0) parts.push(`sleep ${Math.floor(params.delaySeconds)}`);
		}
		parts.push(params.command);
		return parts.join("\n");
	}

	// Tool-call rendering helpers, bound to the active target getter.
	const render = createRender(get, localCwd);
	const { str, remoteDisplayPath, accentRemotePath, readLineRange, sshTitle, renderEditDiffResult } = render;

	// Shared context handed to every subsystem/tool module. Managers are attached
	// just below (they capture ctx lazily, so the forward reference is safe).
	const ctx: SshContext = {
		pi,
		localCwd,
		getTarget: get,
		requireTarget,
		poller,
		monitors,
		emit,
		render,
		connect,
		switchTarget,
		disconnect,
		refreshStatus,
		connectedText,
		statusLabel,
		profileNames,
		profilesPath,
		saveProfile,
		expandProfile,
		buildSshBashCommand,
		tunnels: undefined as unknown as TunnelManager,
		sync: undefined as unknown as SyncManager,
	};
	ctx.tunnels = createTunnelManager(ctx);
	ctx.sync = createSyncManager(ctx);

	// --- agent tools (registered through the shared context) ---
	setupConnectionTools(ctx);
	setupFsTools(ctx);
	setupBashTool(ctx);
	setupProcessTool(ctx);
	setupMonitorTool(ctx);
	setupTransferTools(ctx);

	// --- session hooks + /ssh dashboard command ---
	setupHooks(ctx);
	setupDashboard(ctx);
}
