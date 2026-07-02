// ---------------------------------------------------------------------------
// Startup cleanup for orphaned pi-owned SSH ControlMaster sockets
// ---------------------------------------------------------------------------

import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSsh } from "./transport";

export interface SweepSocketEntry {
	path: string;
	mtimeMs: number;
}

export interface SweepResult {
	checked: number;
	removed: number;
	live: number;
	skippedCurrent: number;
	skippedYoung: number;
	errors: number;
	limited: boolean;
}

export interface SweepOptions {
	currentSocket?: string;
	minAgeMs?: number;
	maxChecks?: number;
	maxDurationMs?: number;
	now?: () => number;
	listFn?: () => Promise<SweepSocketEntry[]>;
	checkFn?: (socket: string) => Promise<boolean>;
	unlinkFn?: (socket: string) => Promise<void>;
}

const DEFAULT_MIN_AGE_MS = 60_000;
const DEFAULT_MAX_CHECKS = 10;
const DEFAULT_MAX_DURATION_MS = 5_000;

export async function listPiSshSockets(dir = tmpdir()): Promise<SweepSocketEntry[]> {
	const names = await readdir(dir);
	const entries: SweepSocketEntry[] = [];
	for (const name of names) {
		if (!/^pi-ssh-[0-9a-f]+\.sock$/.test(name)) continue;
		const path = join(dir, name);
		try {
			const st = await stat(path);
			if (st.isSocket()) entries.push({ path, mtimeMs: st.mtimeMs });
		} catch {
			/* disappeared between readdir and stat */
		}
	}
	entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
	return entries;
}

export async function checkControlSocket(socket: string): Promise<boolean> {
	const r = await runSsh(["-O", "check", "-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "-o", `ControlPath=${socket}`, "--", "placeholder"], { timeout: 2 }).catch(() => null);
	return r?.code === 0;
}

export async function sweepStaleSockets(opts: SweepOptions = {}): Promise<SweepResult> {
	const now = opts.now ?? (() => Date.now());
	const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
	const maxChecks = opts.maxChecks ?? DEFAULT_MAX_CHECKS;
	const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
	const listFn = opts.listFn ?? listPiSshSockets;
	const checkFn = opts.checkFn ?? checkControlSocket;
	const unlinkFn = opts.unlinkFn ?? unlink;
	const startedAt = now();
	const res: SweepResult = {
		checked: 0,
		removed: 0,
		live: 0,
		skippedCurrent: 0,
		skippedYoung: 0,
		errors: 0,
		limited: false,
	};

	for (const entry of await listFn()) {
		if (opts.currentSocket && entry.path === opts.currentSocket) {
			res.skippedCurrent++;
			continue;
		}
		if (now() - entry.mtimeMs < minAgeMs) {
			res.skippedYoung++;
			continue;
		}
		if (res.checked >= maxChecks || now() - startedAt >= maxDurationMs) {
			res.limited = true;
			break;
		}
		res.checked++;
		try {
			if (await checkFn(entry.path)) {
				res.live++;
				continue;
			}
			await unlinkFn(entry.path);
			res.removed++;
		} catch {
			res.errors++;
		}
	}

	return res;
}

export function startStaleSocketSweep(currentSocket?: string): void {
	void sweepStaleSockets({ currentSocket }).catch(() => {});
}
