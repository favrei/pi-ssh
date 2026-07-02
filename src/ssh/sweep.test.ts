import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepStaleSockets, type SweepSocketEntry } from "./sweep";

test("sweepStaleSockets skips current and young sockets, removes dead ones", async () => {
	let now = 100_000;
	const entries: SweepSocketEntry[] = [
		{ path: "current.sock", mtimeMs: 0 },
		{ path: "young.sock", mtimeMs: 99_000 },
		{ path: "dead.sock", mtimeMs: 1 },
		{ path: "live.sock", mtimeMs: 2 },
	];
	const checked: string[] = [];
	const removed: string[] = [];
	const res = await sweepStaleSockets({
		currentSocket: "current.sock",
		now: () => now,
		listFn: async () => entries,
		checkFn: async (socket) => {
			checked.push(socket);
			return socket === "live.sock";
		},
		unlinkFn: async (socket) => {
			removed.push(socket);
		},
	});
	assert.deepEqual(checked, ["dead.sock", "live.sock"]);
	assert.deepEqual(removed, ["dead.sock"]);
	assert.equal(res.checked, 2);
	assert.equal(res.removed, 1);
	assert.equal(res.live, 1);
	assert.equal(res.skippedCurrent, 1);
	assert.equal(res.skippedYoung, 1);
});

test("sweepStaleSockets honors check and duration limits", async () => {
	let now = 100_000;
	const entries: SweepSocketEntry[] = [
		{ path: "a.sock", mtimeMs: 0 },
		{ path: "b.sock", mtimeMs: 0 },
		{ path: "c.sock", mtimeMs: 0 },
	];
	const checked: string[] = [];
	const res = await sweepStaleSockets({
		now: () => now,
		maxChecks: 2,
		listFn: async () => entries,
		checkFn: async (socket) => {
			checked.push(socket);
			now += 10;
			return true;
		},
		unlinkFn: async () => {},
	});
	assert.deepEqual(checked, ["a.sock", "b.sock"]);
	assert.equal(res.checked, 2);
	assert.equal(res.limited, true);
});

test("sweepStaleSockets reports unlink/check errors and continues", async () => {
	const entries: SweepSocketEntry[] = [
		{ path: "bad-check.sock", mtimeMs: 0 },
		{ path: "bad-unlink.sock", mtimeMs: 0 },
		{ path: "ok.sock", mtimeMs: 0 },
	];
	const removed: string[] = [];
	const res = await sweepStaleSockets({
		now: () => 100_000,
		listFn: async () => entries,
		checkFn: async (socket) => {
			if (socket === "bad-check.sock") throw new Error("check failed");
			return false;
		},
		unlinkFn: async (socket) => {
			if (socket === "bad-unlink.sock") throw new Error("unlink failed");
			removed.push(socket);
		},
	});
	assert.deepEqual(removed, ["ok.sock"]);
	assert.equal(res.checked, 3);
	assert.equal(res.errors, 2);
	assert.equal(res.removed, 1);
});
