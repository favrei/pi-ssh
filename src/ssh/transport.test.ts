import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloseGuard, isTransportSuccessAfterRetry } from "./transport";
import type { RunResult } from "../types";

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

test("isTransportSuccessAfterRetry distinguishes command failure from transport failure", () => {
	const result = (patch: Partial<RunResult>): RunResult => ({
		code: 0,
		signal: null,
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		timedOut: false,
		...patch,
	});
	assert.equal(isTransportSuccessAfterRetry(result({ code: 0 })), true);
	assert.equal(isTransportSuccessAfterRetry(result({ code: 1 })), true);
	assert.equal(isTransportSuccessAfterRetry(result({ code: 255, stderr: Buffer.from("mux_client_request_session failed") })), false);
	assert.equal(isTransportSuccessAfterRetry(result({ timedOut: true })), false);
	assert.equal(isTransportSuccessAfterRetry(result({ signal: "SIGTERM" })), false);
});
