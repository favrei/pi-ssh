// ---------------------------------------------------------------------------
// ssh_push / ssh_pull: rsync the workspace to/from the remote
// ---------------------------------------------------------------------------

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { SshContext } from "../context";
import { runRemoteCommand, sshFailureMessage } from "../ssh/transport";
import { ensureTrailingSlash, runRsyncTransfer, rsyncStreamer } from "../transfer";
import { formatDuration, shQuote, summarizeRsync, toRemotePath } from "../utils";

export function setupTransferTools(ssh: SshContext): void {
	const { pi, localCwd, requireTarget, render } = ssh;
	const { str, remoteDisplayPath, sshTitle } = render;

	pi.registerTool({
		name: "ssh_push",
		label: "ssh_push",
		description: "Push local files to the active SSH remote using rsync over the reused SSH connection. Respects .gitignore via rsync filter. Local read/write/edit remain local.",
		promptSnippet: "Rsync local workspace files to the active SSH remote",
		promptGuidelines: ["Use ssh_push before remote testing when local edits need to be synced to the active SSH remote."],
		parameters: Type.Object({
			localPath: Type.Optional(Type.String({ description: "Local path to push, defaults to current workspace" })),
			remotePath: Type.Optional(Type.String({ description: "Remote destination path, defaults to remote cwd" })),
			delete: Type.Optional(Type.Boolean({ description: "Delete remote files absent locally (default false)" })),
			dryRun: Type.Optional(Type.Boolean({ description: "Preview the transfer without writing (rsync --dry-run). Useful before pushing a large tree." })),
			excludes: Type.Optional(Type.Array(Type.String(), { description: "Additional rsync exclude patterns" })),
			verbose: Type.Optional(Type.Boolean({ description: "Stream the full per-file itemized list. Default false: only a one-line summary (files, bytes, time) to save context." })),
		}),
		renderCall(args: any, theme: any, context: any) {
			const from = theme.fg("accent", str(args?.localPath) || ".");
			const to = theme.fg("accent", args?.remotePath ? remoteDisplayPath(str(args.remotePath)) : "remote cwd");
			const dry = args?.dryRun ? ` ${theme.fg("muted", "(dry-run)")}` : "";
			return sshTitle("push", `${from} ${theme.fg("muted", "\u2192")} ${to}${dry}`, theme, context);
		},
		async execute(_id, params: { localPath?: string; remotePath?: string; delete?: boolean; dryRun?: boolean; excludes?: string[]; verbose?: boolean }, signal, onUpdate) {
			const t = requireTarget();
			const localSourcePath = resolve(localCwd, params.localPath ?? ".");
			const localSource = (await stat(localSourcePath)).isDirectory() ? ensureTrailingSlash(localSourcePath) : localSourcePath;
			const remoteDest = ensureTrailingSlash(params.remotePath ? toRemotePath(params.remotePath, localCwd, t.remoteCwd, t.remoteHome) : t.remoteCwd);
			const verbose = params.verbose ?? false;
			const fallback = `Pushed ${localSource} -> ${t.remote}:${remoteDest}`;
			const { stdout, elapsedMs } = await runRsyncTransfer(
				localCwd,
				t,
				localSource,
				`${t.remote}:${remoteDest}`,
				{ delete: params.delete, dryRun: params.dryRun, excludes: params.excludes, gitignore: true, verbose },
				signal,
				verbose ? rsyncStreamer(onUpdate) : undefined,
			);
			const prefix = params.dryRun ? "[dry-run] " : "";
			const body = verbose ? (stdout || fallback) : `${summarizeRsync(stdout, fallback)} in ${formatDuration(elapsedMs)}`;
			return { content: [{ type: "text" as const, text: `${prefix}${body}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "ssh_pull",
		label: "ssh_pull",
		description: "Pull files from the active SSH remote to the local workspace using rsync over the reused SSH connection.",
		promptSnippet: "Rsync files from the active SSH remote to local workspace",
		parameters: Type.Object({
			remotePath: Type.Optional(Type.String({ description: "Remote source path, defaults to remote cwd" })),
			localPath: Type.Optional(Type.String({ description: "Local destination path, defaults to current workspace" })),
			delete: Type.Optional(Type.Boolean({ description: "Delete local files absent remotely (default false; use carefully)" })),
			dryRun: Type.Optional(Type.Boolean({ description: "Preview the transfer without writing (rsync --dry-run)." })),
			excludes: Type.Optional(Type.Array(Type.String(), { description: "Additional rsync exclude patterns" })),
			verbose: Type.Optional(Type.Boolean({ description: "Stream the full per-file itemized list. Default false: only a one-line summary (files, bytes, time) to save context." })),
		}),
		renderCall(args: any, theme: any, context: any) {
			const from = theme.fg("accent", args?.remotePath ? remoteDisplayPath(str(args.remotePath)) : "remote cwd");
			const to = theme.fg("accent", str(args?.localPath) || ".");
			const dry = args?.dryRun ? ` ${theme.fg("muted", "(dry-run)")}` : "";
			return sshTitle("pull", `${from} ${theme.fg("muted", "\u2192")} ${to}${dry}`, theme, context);
		},
		async execute(_id, params: { remotePath?: string; localPath?: string; delete?: boolean; dryRun?: boolean; excludes?: string[]; verbose?: boolean }, signal, onUpdate) {
			const t = requireTarget();
			const remoteSourcePath = params.remotePath ? toRemotePath(params.remotePath, localCwd, t.remoteCwd, t.remoteHome) : t.remoteCwd;
			const q = shQuote(remoteSourcePath);
			const kind = await runRemoteCommand(t, `if [ -d ${q} ]; then printf d; elif [ -e ${q} ]; then printf f; else exit 44; fi`, { login: false });
			if (kind.code === 44) throw new Error(`Remote source not found: ${remoteSourcePath}`);
			if (kind.code !== 0) throw new Error(`${sshFailureMessage(kind)}: ${kind.stderr.toString().trim() || remoteSourcePath}`);
			const remoteSource = kind.stdout.toString() === "d" ? ensureTrailingSlash(remoteSourcePath) : remoteSourcePath;
			const localDest = ensureTrailingSlash(resolve(localCwd, params.localPath ?? "."));
			const verbose = params.verbose ?? false;
			const fallback = `Pulled ${t.remote}:${remoteSource} -> ${localDest}`;
			const { stdout, elapsedMs } = await runRsyncTransfer(
				localCwd,
				t,
				`${t.remote}:${remoteSource}`,
				localDest,
				{ delete: params.delete, dryRun: params.dryRun, excludes: params.excludes, gitignore: false, verbose },
				signal,
				verbose ? rsyncStreamer(onUpdate) : undefined,
			);
			const prefix = params.dryRun ? "[dry-run] " : "";
			const body = verbose ? (stdout || fallback) : `${summarizeRsync(stdout, fallback)} in ${formatDuration(elapsedMs)}`;
			return { content: [{ type: "text" as const, text: `${prefix}${body}` }], details: undefined };
		},
	});
}
