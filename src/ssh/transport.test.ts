import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloseGuard } from "./transport";

test("createCloseGuard merges in-flight closes for the same socket", async () => {
	let release!: () => void;
	let calls = 0;
	const guard = createCloseGuard();
	const p1 = guard("sock", { reason: "retry" }, async () => {
		calls++;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	const p2 = guard("sock", { reason: "retry" }, async () => {
		calls++;
	});
	assert.equal(p2, p1);
	assert.equal(calls, 1);
	release();
	assert.equal(await p1, true);
	assert.equal(await p2, true);
});

test("createCloseGuard debounces only retry cleanup", async () => {
	let now = 1_000;
	let calls = 0;
	const guard = createCloseGuard(() => now);
	const close = async () => {
		calls++;
	};

	assert.equal(await guard("sock", { reason: "retry" }, close), true);
	assert.equal(calls, 1);
	now += 1_999;
	assert.equal(await guard("sock", { reason: "retry" }, close), false);
	assert.equal(calls, 1);
	assert.equal(await guard("sock", {}, close), true);
	assert.equal(calls, 2);
	now += 1;
	assert.equal(await guard("sock", { reason: "retry" }, close), true);
	assert.equal(calls, 3);
});
