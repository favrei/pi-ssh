// Regression test for the lost-notification ordering bug.
//
// Observed live (2026-09-15): remote job finished exit 0, remote `notified`
// marker IS set, but no completion notice exists in any session file.
// Root cause (src/poller.ts fireCompletion): the `notified` marker is touched
// BEFORE the emit, and emit failure is never handled — so one lost emit
// becomes permanently silent (rehydrate skips marked jobs forever).
//
// Strategy: fake `ssh` on PATH (the poller only talks to the remote through
// it) plus a fake `pi` whose sendMessage throws (dead session/teardown race).
// Desired behavior, RED until fixed:
//   1. failed emit -> `notified` must NOT be touched
//   2. next tick retries and delivers once sendMessage works again
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshTarget } from "./types";
import { createPollerManager } from "./poller";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeSsh(stateDir: string): string {
	const bin = mkdtempSync(join(tmpdir(), "fake-ssh-"));
	const script = `#!/bin/bash
cmd="\${@: -1}"
state="${stateDir}"
if [[ "$cmd" == *"kill -0"* ]]; then
  if [[ -f "$state/done" ]]; then printf 'done\\t%s\\n' "$(cat "$state/code")"; else printf 'running\\t\\n'; fi
  exit 0
fi
if [[ "$cmd" == *"touch --"* ]]; then touch "$state/marker"; exit 0; fi
if [[ "$cmd" == *"tail -n 15"* ]]; then echo "fake log tail"; exit 0; fi
exit 0
`;
	const p = join(bin, "ssh");
	writeFileSync(p, script);
	chmodSync(p, 0o755);
	return bin;
}

function makeTarget(): SshTarget {
	return {
		remote: "u@h",
		socket: "/tmp/fake.sock",
		sshOptions: [],
		shellKind: "bash",
	} as unknown as SshTarget;
}

test("failed emit must not mark notified; retry must deliver (lost-notification ordering bug)", async (t) => {
	const state = mkdtempSync(join(tmpdir(), "poller-repro-"));
	const fakeBin = makeFakeSsh(state);
	const savedPath = process.env.PATH ?? "";
	process.env.PATH = `${fakeBin}:${savedPath}`;
	t.after(() => {
		process.env.PATH = savedPath;
	});
	const delivered: string[] = [];
	let sendWorks = false;
	const pi = {
		sendMessage: (msg: any) => {
			if (!sendWorks) throw new Error("session gone");
			delivered.push(String(msg?.content ?? msg));
		},
	} as any;

	const mgr = createPollerManager(pi);
	mgr.startPoller({
		procId: "repro1",
		name: "repro-job",
		dir: "/remote/.pi-ssh-processes/repro1",
		target: makeTarget(),
		alertOnSuccess: true,
		alertOnFailure: true,
		alertOnKill: true,
	});
	t.after(() => mgr.stopAll());
	await sleep(4500); // let a "running" tick pass
	assert.equal(delivered.length, 0);

	// Job finishes while the session is dead.
	writeFileSync(join(state, "code"), "0");
	writeFileSync(join(state, "done"), "");
	await sleep(4500); // completion tick runs; emit throws

	assert.equal(
		existsSync(join(state, "marker")),
		false,
		"BUG: `notified` was touched even though the emit failed — " +
			"rehydrate will now skip this job forever (this is the U-joint loss)",
	);

	// Session comes back (reconnect heals sendMessage): next tick must deliver.
	sendWorks = true;
	await sleep(4500);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0], /success.*exit 0/);
});
