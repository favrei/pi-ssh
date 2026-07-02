import { test } from "node:test";
import assert from "node:assert/strict";
import {
	detectLocalGlobalControlMaster,
	formatDoctorReport,
	globalControlMasterBlocks,
	parseControlMasterBlocks,
} from "./doctor";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SshTarget } from "./types";

test("parseControlMasterBlocks finds global Host star and include caveats", () => {
	const parsed = parseControlMasterBlocks(`
Include ~/.ssh/conf.d/*

Host *
  ServerAliveInterval 30
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%ps
  ControlPersist 10m

Host gpu
  HostName example.com
  ControlMaster no

Match all
  ControlMaster auto
`);
	const globals = globalControlMasterBlocks(parsed);
	assert.equal(globals.length, 1);
	assert.equal(globals[0].kind, "host");
	assert.equal(globals[0].line, 4);
	assert.equal(globals[0].controlMaster, "auto");
	assert.equal(globals[0].controlPath, "~/.ssh/cm-%r@%h:%ps");
	assert.deepEqual(parsed.includes, [{ line: 2, value: "~/.ssh/conf.d/*" }]);
	assert.equal(parsed.blocks.length, 3);
});

test("globalControlMasterBlocks ignores non-global and disabled settings", () => {
	const parsed = parseControlMasterBlocks(`
Host *
  ControlMaster no

Host *.internal
  ControlMaster auto

Match host *
  ControlMaster auto
`);
	assert.equal(globalControlMasterBlocks(parsed).length, 0);
});

test("detectLocalGlobalControlMaster reads a config path without following includes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ssh-doctor-"));
	const configPath = join(dir, "config");
	writeFileSync(configPath, "Include other\nHost *\n  ControlMaster auto\n");
	const detected = detectLocalGlobalControlMaster(configPath);
	assert.equal(detected.path, configPath);
	assert.equal(detected.hasGlobalControlMaster, true);
});

test("formatDoctorReport explains local and pi ControlMaster ownership", () => {
	const target: SshTarget = {
		remote: "chiyu@159.195.192.70",
		remoteCwd: "/home/chiyu",
		remoteHome: "/home/chiyu",
		socket: "/tmp/pi-ssh-current.sock",
		hasPython: true,
		sshOptions: [],
		loginShell: "/usr/bin/zsh",
		shellKind: "zsh",
		loginEnvDirty: true,
	};
	const config = {
		path: "/Users/chiyuh/.ssh/config",
		exists: true,
		...parseControlMasterBlocks("Host *\n  ControlMaster auto\n  ControlPath ~/.ssh/cm-%r@%h:%ps\n"),
	};
	const out = formatDoctorReport({
		target,
		config,
		sockets: [
			{ path: "/tmp/pi-ssh-current.sock", current: true, state: "live" },
			{ path: "/tmp/pi-ssh-old.sock", current: false, state: "dead" },
		],
	});
	assert.match(out, /Connection: chiyu@159\.195\.192\.70:\/home\/chiyu/);
	assert.match(out, /Login env: stale/);
	assert.match(out, /Global ControlMaster: detected/);
	assert.match(out, /ssh -O exit chiyu@159\.195\.192\.70/);
	assert.match(out, /pi uses private \/tmp\/pi-ssh-\*\.sock sockets/);
	assert.match(out, /\* live\s+\/tmp\/pi-ssh-current\.sock/);
	assert.match(out, /- dead\s+\/tmp\/pi-ssh-old\.sock/);
});
