import { test } from "node:test";
import assert from "node:assert/strict";
import {
	detectLocalGlobalControlMaster,
	formatDoctorReport,
	formatSshExitCommand,
	globalControlMasterBlocks,
	inspectUserControlMaster,
	parseControlMasterBlocks,
	parseSshGOutput,
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

test("parseSshGOutput extracts resolved connection and mux fields", () => {
	const parsed = parseSshGOutput(`
user chiyu
hostname 159.195.192.70
port 22
controlmaster auto
controlpath /Users/chiyuh/.ssh/cm-chiyu@159.195.192.70:22s
controlpersist 600
`);
	assert.deepEqual(parsed, {
		user: "chiyu",
		hostname: "159.195.192.70",
		port: "22",
		controlMaster: "auto",
		controlPath: "/Users/chiyuh/.ssh/cm-chiyu@159.195.192.70:22s",
		controlPersist: "600",
	});
});

test("inspectUserControlMaster checks resolved ControlPath and formats exit command", async () => {
	const target: SshTarget = {
		remote: "chiyu@example.com",
		remoteCwd: "/work",
		remoteHome: "/home/chiyu",
		socket: "/tmp/pi.sock",
		hasPython: true,
		sshOptions: ["-i", "/tmp/key with space.pem", "-p", "2222"],
		loginShell: "/bin/bash",
		shellKind: "bash",
	};
	const checked: string[] = [];
	const report = await inspectUserControlMaster(target, {
		runSshG: async () => ({
			code: 0,
			stdout: Buffer.from("user chiyu\nhostname example.com\nport 2222\ncontrolmaster auto\ncontrolpath /tmp/cm.sock\ncontrolpersist 600\n"),
			stderr: Buffer.from("Pseudo-terminal will not be allocated\n"),
			timedOut: false,
			signal: null,
		}),
		checkFn: async (socket) => {
			checked.push(socket);
			return true;
		},
	});
	assert.deepEqual(checked, ["/tmp/cm.sock"]);
	assert.equal(report.state, "live");
	assert.equal(report.config?.controlPath, "/tmp/cm.sock");
	assert.equal(formatSshExitCommand(target), "ssh -O exit -i '/tmp/key with space.pem' -p 2222 chiyu@example.com");
	assert.equal(report.exitCommand, "ssh -O exit -i '/tmp/key with space.pem' -p 2222 chiyu@example.com");
});

test("inspectUserControlMaster reports not-configured when ssh -G disables mux", async () => {
	const target: SshTarget = {
		remote: "host",
		remoteCwd: "/work",
		remoteHome: "/home/me",
		socket: "/tmp/pi.sock",
		hasPython: true,
		sshOptions: [],
		loginShell: "/bin/bash",
		shellKind: "bash",
	};
	const report = await inspectUserControlMaster(target, {
		runSshG: async () => ({
			code: 0,
			stdout: Buffer.from("controlmaster no\ncontrolpath none\n"),
			stderr: Buffer.alloc(0),
			timedOut: false,
			signal: null,
		}),
		checkFn: async () => {
			throw new Error("should not check");
		},
	});
	assert.equal(report.state, "not-configured");
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
		userControlMaster: {
			config: {
				user: "chiyu",
				hostname: "159.195.192.70",
				port: "22",
				controlMaster: "auto",
				controlPath: "/Users/chiyuh/.ssh/cm-chiyu@159.195.192.70:22s",
				controlPersist: "600",
			},
			state: "live",
			exitCommand: "ssh -O exit chiyu@159.195.192.70",
		},
		sockets: [
			{ path: "/tmp/pi-ssh-current.sock", current: true, state: "live" },
			{ path: "/tmp/pi-ssh-old.sock", current: false, state: "dead" },
		],
	});
	assert.match(out, /Connection: chiyu@159\.195\.192\.70:\/home\/chiyu/);
	assert.match(out, /Login env: stale/);
	assert.match(out, /Global ControlMaster: detected/);
	assert.match(out, /Resolved terminal SSH mux/);
	assert.match(out, /ControlPath=\/Users\/chiyuh\/\.ssh\/cm-chiyu@159\.195\.192\.70:22s/);
	assert.match(out, /User-side master: live/);
	assert.match(out, /Refresh command: ssh -O exit chiyu@159\.195\.192\.70/);
	assert.match(out, /pi uses private \/tmp\/pi-ssh-\*\.sock sockets/);
	assert.match(out, /\* live\s+\/tmp\/pi-ssh-current\.sock/);
	assert.match(out, /- dead\s+\/tmp\/pi-ssh-old\.sock/);
});
