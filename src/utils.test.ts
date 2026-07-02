import { test } from "node:test";
import assert from "node:assert/strict";
import { toRemotePath } from "./utils";

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
