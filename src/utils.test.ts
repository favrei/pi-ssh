import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTextContent, lastNonEmptyLine, loginEnvFileKind, toRemotePath } from "./utils";

test("toRemotePath maps remote home when provided", () => {
	assert.equal(toRemotePath("~", "/local/repo", "/remote/work", "/home/chiyu"), "/home/chiyu");
	assert.equal(toRemotePath("~/.zshrc", "/local/repo", "/remote/work", "/home/chiyu"), "/home/chiyu/.zshrc");
	assert.equal(toRemotePath("~/a/../b", "/local/repo", "/remote/work", "/home/chiyu/"), "/home/chiyu/b");
});

test("toRemotePath rejects tilde paths without remote home or for other users", () => {
	assert.throws(() => toRemotePath("~/.zshrc", "/local/repo", "/remote/work"), /needs remote home/);
	assert.throws(() => toRemotePath("~root/.ssh/config", "/local/repo", "/remote/work", "/home/chiyu"), /other users/);
});

test("toRemotePath keeps existing local and remote path mapping behavior", () => {
	assert.equal(toRemotePath("src/index.ts", "/local/repo", "/remote/work", "/home/chiyu"), "/remote/work/src/index.ts");
	assert.equal(toRemotePath("/remote/work/src/index.ts", "/local/repo", "/remote/work", "/home/chiyu"), "/remote/work/src/index.ts");
	assert.equal(toRemotePath("/etc/profile", "/local/repo", "/remote/work", "/home/chiyu"), "/etc/profile");
	assert.throws(() => toRemotePath("../outside", "/local/repo", "/remote/work", "/home/chiyu"), /outside workspace/);
});

test("loginEnvFileKind detects login environment files", () => {
	assert.equal(loginEnvFileKind("/home/chiyu/.zshrc"), ".zshrc");
	assert.equal(loginEnvFileKind("/home/chiyu/.config/../.bash_profile"), ".bash_profile");
	assert.equal(loginEnvFileKind("/home/chiyu/.ssh/environment"), ".ssh/environment");
	assert.equal(loginEnvFileKind("/home/chiyu/.ssh/rc"), ".ssh/rc");
	assert.equal(loginEnvFileKind("/etc/profile"), "/etc/profile");
	assert.equal(loginEnvFileKind("/etc/environment"), "/etc/environment");
	assert.equal(loginEnvFileKind("/etc/zsh/zprofile"), "/etc/zsh/*");
	assert.equal(loginEnvFileKind("/etc/profile.d/conda.sh"), "/etc/profile.d/*");
	assert.equal(loginEnvFileKind("/home/chiyu/.zsh_history"), null);
	assert.equal(loginEnvFileKind("/etc/profile.d"), null);
});

test("appendTextContent appends to the last text block or creates one", () => {
	const result = appendTextContent({ content: [{ type: "image", data: "x" }, { type: "text", text: "done" }], details: { ok: true } }, "note");
	assert.deepEqual(result, { content: [{ type: "image", data: "x" }, { type: "text", text: "done\nnote" }], details: { ok: true } });
	const added = appendTextContent({ details: { ok: true } }, "note");
	assert.deepEqual(added, { content: [{ type: "text", text: "note" }], details: { ok: true } });
});

test("lastNonEmptyLine tolerates profile banners before machine output", () => {
	assert.equal(lastNonEmptyLine("banner\n\n{\"ok\":true}\n"), "{\"ok\":true}");
	assert.equal(lastNonEmptyLine("\n  \n"), "");
});
