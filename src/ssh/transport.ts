// ---------------------------------------------------------------------------
// SSH transport: spawning ssh, ControlMaster options, remote command execution
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import type { RunOptions, RunResult, SshTarget } from "../types";
import { shQuote } from "../utils";
import {
	abortableSleep,
	backoffDelay,
	notifyReconnect,
	RECONNECT_MAX_ATTEMPTS,
	reconnectCtx,
} from "./reconnect";

export function runSsh(args: string[], opts?: RunOptions): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (opts?.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const child = spawn("ssh", args, { stdio: [opts?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let settled = false;
		let timedOut = false;
		child.stdout!.on("data", (d) => out.push(d));
		child.stderr!.on("data", (d) => err.push(d));
		let timer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const clearTimers = () => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
		};
		const terminate = () => {
			child.kill("SIGTERM");
			if (!killTimer) {
				killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
				killTimer.unref?.();
			}
		};
		if (opts?.timeout) {
			timer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, opts.timeout * 1000);
		}
		const onAbort = () => terminate();
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimers();
			opts?.signal?.removeEventListener("abort", onAbort);
			reject(e);
		});
		child.on("close", (code, closeSignal) => {
			if (settled) return;
			settled = true;
			clearTimers();
			opts?.signal?.removeEventListener("abort", onAbort);
			resolve({ code, signal: closeSignal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
		});
		if (opts?.stdin !== undefined) {
			child.stdin!.on("error", (e) => {
				if (settled) return;
				settled = true;
				clearTimers();
				opts?.signal?.removeEventListener("abort", onAbort);
				reject(e);
			});
			child.stdin!.end(opts.stdin);
		}
	});
}

/** Common ssh args for every invocation: BatchMode + ControlMaster multiplexing. */
export function baseSshOptions(socket: string): string[] {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=10",
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPath=${socket}`,
		"-o",
		"ControlPersist=600",
	];
}

export function sshConnArgs(t: SshTarget): string[] {
	return [...t.sshOptions, ...baseSshOptions(t.socket), "--", t.remote];
}

export function remoteShell(command: string, login = true): string {
	return `bash ${login ? "-lc" : "-c"} ${shQuote(command)}`;
}

export function sshFailureMessage(r: RunResult): string {
	if (r.timedOut) return "SSH timed out";
	if (r.signal) return `SSH terminated by signal ${r.signal}`;
	return `SSH failed (${r.code ?? "unknown"})`;
}

export function isRetryableSshFailure(r: RunResult): boolean {
	if (r.code !== 255 || r.timedOut || r.signal) return false;
	const message = `${r.stderr.toString()}\n${r.stdout.toString()}`;
	return /mux_client_request_session|Control socket connect|Connection reset|Connection closed|Broken pipe|Connection timed out|Connection refused|No route to host|kex_exchange_identification/i.test(message);
}

export async function runRemoteCommand(t: SshTarget, command: string, opts?: RunOptions): Promise<RunResult> {
	const shell = remoteShell(command, opts?.login !== false);
	const reconnect = opts?.reconnect ?? reconnectCtx.getStore()?.reconnect ?? false;
	const maxAttempts = reconnect ? RECONNECT_MAX_ATTEMPTS : 2; // 2 => historical retry-once
	let r = await runSsh([...sshConnArgs(t), shell], opts);
	let attempt = 1;
	while (isRetryableSshFailure(r) && !opts?.signal?.aborted && attempt < maxAttempts) {
		const next = attempt + 1;
		await closeMaster(t, { reason: "retry" });
		if (reconnect) {
			const delayMs = backoffDelay(next);
			notifyReconnect("retrying", { remote: t.remote, attempt: next, max: maxAttempts, delayMs });
			if (await abortableSleep(delayMs, opts?.signal)) break;
		}
		r = await runSsh([...sshConnArgs(t), shell], opts);
		attempt = next;
	}
	if (reconnect && attempt > 1) {
		notifyReconnect(isRetryableSshFailure(r) ? "gaveup" : "recovered", { remote: t.remote, attempt, max: maxAttempts, delayMs: 0 });
	}
	return r;
}

export async function sshExec(t: SshTarget, command: string): Promise<Buffer> {
	const r = await runRemoteCommand(t, command);
	if (r.code !== 0) {
		throw new Error(`${sshFailureMessage(r)}: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
	}
	return r.stdout;
}

export async function probePython(t: SshTarget): Promise<boolean> {
	const r = await runRemoteCommand(t, "python3 --version");
	return r.code === 0;
}

export type CloseMasterReason = "retry";

export function createCloseGuard(now: () => number = () => Date.now()) {
	const inFlight = new Map<string, Promise<boolean>>();
	const lastRetryClosedAt = new Map<string, number>();
	return (socket: string, opts: { reason?: CloseMasterReason; debounceMs?: number }, fn: () => Promise<void>): Promise<boolean> => {
		const existing = inFlight.get(socket);
		if (existing) return existing;
		if (opts.reason === "retry") {
			const last = lastRetryClosedAt.get(socket);
			if (last !== undefined && now() - last < (opts.debounceMs ?? 2000)) {
				return Promise.resolve(false);
			}
		}
		const run = (async () => {
			try {
				await fn();
				return true;
			} finally {
				if (opts.reason === "retry") lastRetryClosedAt.set(socket, now());
			}
		})();
		inFlight.set(socket, run);
		void run.finally(() => {
			if (inFlight.get(socket) === run) inFlight.delete(socket);
		});
		return run;
	};
}

const closeGuard = createCloseGuard();

export async function closeMaster(t: SshTarget, opts: { unlinkSocket?: boolean; reason?: CloseMasterReason } = {}): Promise<void> {
	// Best-effort teardown; ignore errors. Removing the socket after the control
	// command keeps a stale/dead mux socket from being re-used on the next invocation.
	const executed = await closeGuard(t.socket, opts, () =>
		runSsh(["-O", "exit", ...t.sshOptions, ...baseSshOptions(t.socket), "--", t.remote], { timeout: 5 }).then(() => undefined, () => undefined),
	);
	if (executed && opts.unlinkSocket !== false) await unlink(t.socket).catch(() => {});
}
