// ---------------------------------------------------------------------------
// Connection management: resolving an SshTarget from a remote spec
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activation, ShellKind, ShellMode, SshTarget } from "../types";
import { shQuote } from "../utils";
import { baseSshOptions, probePython, runSsh, sshFailureMessage, wrapForShell } from "./transport";

export async function resolveTarget(remote: string, path?: string, sshOptions: string[] = [], activation?: Activation, shellMode: ShellMode = "auto"): Promise<SshTarget> {
	const socket = join(tmpdir(), `pi-ssh-${randomBytes(4).toString("hex")}.sock`);
	const shellProbe = await probeLoginShell(socket, remote, sshOptions);
	let shellKind: ShellKind = shellMode === "auto" ? shellProbe.shellKind : shellMode;
	let shellNote = shellProbe.shellNote;
	let shellStartupStderr: string | undefined;
	if (shellKind === "zsh") {
		const sanity = await checkZshStartup(socket, remote, sshOptions);
		if (!sanity.ok) {
			const reason = sanity.timedOut ? "zsh startup sanity check timed out" : sanity.code !== 0 ? `zsh startup sanity check exited ${sanity.code ?? "unknown"}` : "zsh startup wrote to stdout";
			if (shellMode === "auto") {
				shellKind = "bash";
				shellNote = `${reason}; using bash -lc`;
			} else {
				shellNote = `${reason}; forced --shell zsh may contaminate command output`;
			}
		} else if (sanity.stderr) {
			shellNote = "zsh startup writes stderr";
			shellStartupStderr = sanity.stderr;
		}
	}
	const remoteCwd = path
		? (await sshExecRaw(socket, remote, sshOptions, `cd -- ${shQuote(path)} && pwd -P`)).toString().trim()
		: (await sshExecRaw(socket, remote, sshOptions, "pwd -P")).toString().trim();
	const t: SshTarget = {
		remote,
		remoteCwd,
		remoteHome: shellProbe.remoteHome || remoteCwd,
		socket,
		hasPython: false,
		sshOptions,
		loginShell: shellProbe.loginShell,
		shellKind,
		shellNote,
		shellStartupStderr,
		defaultCommandPrefix: activation?.commandPrefix?.trim() || undefined,
		defaultEnv: activation?.env && Object.keys(activation.env).length ? activation.env : undefined,
	};
	t.hasPython = await probePython(t);
	return t;
}

// sshExec before we have a full target (used during resolve for pwd probe).
export async function sshExecRaw(socket: string, remote: string, sshOptions: string[], command: string): Promise<Buffer> {
	const r = await runSsh([
		...sshOptions,
		...baseSshOptions(socket),
		"--",
		remote,
		wrapForShell("bash", true, command),
	]);
	if (r.code !== 0) {
		throw new Error(`${sshFailureMessage(r)}: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
	}
	return r.stdout;
}

function classifyShell(shell: string): ShellKind {
	const base = shell.trim().split("/").pop() ?? "";
	if (base === "zsh") return "zsh";
	if (base === "bash") return "bash";
	return "other";
}

async function probeLoginShell(socket: string, remote: string, sshOptions: string[]): Promise<{ loginShell: string; remoteHome: string; shellKind: ShellKind; shellNote?: string }> {
	const primary = await runSsh([...sshOptions, ...baseSshOptions(socket), "--", remote, `printf '%s\\t%s\\n' "$SHELL" "$HOME"`], { timeout: 10 }).catch(() => null);
	const [rawShell = "", rawHome = ""] = primary?.code === 0 ? primary.stdout.toString().trim().split("\t") : [];
	let loginShell = rawShell.trim();
	let remoteHome = rawHome.trim();
	let shellNote: string | undefined;
	if (!loginShell || !remoteHome) {
		const fallback = await sshExecRaw(socket, remote, sshOptions, `getent passwd "$(id -un)" | awk -F: '{print $6 "\\t" $7}'`).catch(() => Buffer.alloc(0));
		const [home = "", shell = ""] = fallback.toString().trim().split("\t");
		remoteHome ||= home.trim();
		loginShell ||= shell.trim();
		if (!loginShell) shellNote = "could not detect login shell; using bash -lc";
	}
	const shellKind = loginShell ? classifyShell(loginShell) : "bash";
	if (shellKind === "other" && !shellNote) shellNote = `unsupported login shell ${loginShell}; using bash -lc`;
	return { loginShell: loginShell || "unknown", remoteHome, shellKind, shellNote };
}

async function checkZshStartup(socket: string, remote: string, sshOptions: string[]): Promise<{ ok: boolean; code: number | null; timedOut: boolean; stderr?: string }> {
	const r = await runSsh([...sshOptions, ...baseSshOptions(socket), "--", remote, wrapForShell("zsh", true, "echo __pi_ok__")], { timeout: 5 }).catch(() => null);
	if (!r) return { ok: false, code: null, timedOut: false };
	const stdout = r.stdout.toString().replace(/\r?\n$/, "");
	const stderr = r.stderr.toString().trim().split("\n").slice(0, 5).join("\n");
	return { ok: r.code === 0 && !r.timedOut && stdout === "__pi_ok__", code: r.code, timedOut: r.timedOut, stderr: stderr || undefined };
}
