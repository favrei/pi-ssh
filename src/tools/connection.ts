// ---------------------------------------------------------------------------
// Agent-callable connection management: ssh_connect / ssh_disconnect / ssh_status
// ---------------------------------------------------------------------------

import { Type } from "typebox";
import type { SshContext } from "../context";
import { formatSshSitrep } from "../sitrep";
import { checkPiControlMaster } from "../doctor";

export function setupConnectionTools(ssh: SshContext): void {
	const { pi, getTarget, switchTarget, disconnect, refreshStatus, connectedText, profileNames, render } = ssh;
	const { str, sshTitle } = render;

	pi.registerTool({
		name: "ssh_connect",
		label: "ssh_connect",
		description: "Connect, reconnect, or switch the active SSH remote for ssh_* tools. Same target syntax as /ssh; supports heartbeat tuning for slow links and fresh hard reconnects.",
		promptSnippet: "Connect or switch the active SSH remote used by ssh_* tools",
		promptGuidelines: [
			"Use ssh_connect when the user asks to connect, disconnect, or switch SSH servers.",
			"Use fresh:true after remote group/PAM/login-environment changes when the current SSH session may have stale login state.",
			"If a slow link falsely reports offline, increase heartbeatIntervalSeconds/heartbeatTimeoutSeconds or disable the observational heartbeat; it never recycles the ControlMaster.",
			"After connecting, use ssh_* tools for remote operations and local tools for local work.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "SSH target: user@host[:/abs/path], ssh options, @profile, plus optional --activate/--env/--shell/--fresh" }),
			fresh: Type.Optional(Type.Boolean({ description: "Close the current pi-owned ControlMaster and remove its socket before connecting, forcing a new remote login session." })),
			heartbeatEnabled: Type.Optional(Type.Boolean({ description: "Enable the observational footer heartbeat (default true)." })),
			heartbeatIntervalSeconds: Type.Optional(Type.Number({ minimum: 0.5, description: "Seconds between heartbeat probes (default 10)." })),
			heartbeatTimeoutSeconds: Type.Optional(Type.Number({ minimum: 1, description: "Per-probe SSH timeout in seconds (default 30)." })),
		}),
		renderCall(args: any, theme: any, context: any) {
			return sshTitle("connect", theme.fg("accent", str(args?.target)), theme, context);
		},
		async execute(_id, params: { target: string; fresh?: boolean; heartbeatEnabled?: boolean; heartbeatIntervalSeconds?: number; heartbeatTimeoutSeconds?: number }, _signal, _onUpdate, ctx) {
			const next = await switchTarget(params.target, {
				fresh: params.fresh,
				heartbeatEnabled: params.heartbeatEnabled,
				heartbeatIntervalSeconds: params.heartbeatIntervalSeconds,
				heartbeatTimeoutSeconds: params.heartbeatTimeoutSeconds,
			});
			refreshStatus(ctx);
			return { content: [{ type: "text" as const, text: connectedText(next) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "ssh_disconnect",
		label: "ssh_disconnect",
		description: "Disconnect the active SSH remote. Local tools are unaffected.",
		promptSnippet: "Disconnect the active SSH remote",
		parameters: Type.Object({}),
		renderCall(_args: any, theme: any, context: any) {
			return sshTitle("disconnect", "", theme, context);
		},
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			await disconnect();
			refreshStatus(ctx);
			return { content: [{ type: "text" as const, text: "SSH disconnected. Local tools remain local." }], details: undefined };
		},
	});

	pi.registerTool({
		name: "ssh_status",
		label: "ssh_status",
		description: "Show the active SSH remote used by ssh_* tools. Pass verbose:true for processes, monitors, tunnels, and sync state.",
		promptSnippet: "Show active SSH connection status",
		parameters: Type.Object({
			verbose: Type.Optional(Type.Boolean({ description: "Include processes, monitors, tunnels, and sync state (default false)" })),
		}),
		renderCall(_args: any, theme: any, context: any) {
			return sshTitle("status", "", theme, context);
		},
		async execute(_id, params: { verbose?: boolean }) {
			const t = getTarget();
			if (!t) return { content: [{ type: "text" as const, text: "SSH: not connected" }], details: undefined };
			if (params.verbose) return { content: [{ type: "text" as const, text: await formatSshSitrep(ssh, t) }], details: undefined };
			const base = connectedText(t);
			const masterLine = `\npi ControlMaster: ${await checkPiControlMaster(t)} (${t.socket})`;
			let profiles: string[] = [];
			try { profiles = profileNames(); } catch { /* corrupt profiles file: ignore for status */ }
			const profileLine = profiles.length ? `\nSaved profiles (reconnect with ssh_connect '@name'): ${profiles.map((n) => `@${n}`).join(", ")}` : "";
			return { content: [{ type: "text" as const, text: base + masterLine + profileLine }], details: undefined };
		},
	});
}
