import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";

import { tmpdir } from "node:os";

import path from "node:path";

import { test } from "node:test";

import { pathToFileURL } from "node:url";

import { cleanEnv, ROOT } from "./helpers/server.js";

const envModule = pathToFileURL(path.join(ROOT, "src", "config", "env.js")).href;

function load(extra) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(envModule)})`], {
    cwd: tmpdir(),

    env: { ...cleanEnv(), ...extra },

    encoding: "utf8",
  });
}

test("正しい値なら読み込める", () => {
  assert.equal(load({ OLLAMA_TIMEOUT: "120000", PORT: "3000" }).status, 0);
});

for (const [name, extra, message] of [
  ["単位付きの値", { OLLAMA_TIMEOUT: "5m" }, /OLLAMA_TIMEOUT must be an integer/],
  ["指数表記", { OLLAMA_TIMEOUT: "3e5" }, /OLLAMA_TIMEOUT must be an integer/],
  ["小さすぎる値", { OLLAMA_TIMEOUT: "500" }, /OLLAMA_TIMEOUT must be between/],
  ["大きすぎる値", { OLLAMA_MAX_DURATION: "3000000000" }, /OLLAMA_MAX_DURATION must be between/],
  ["範囲外のポート", { PORT: "70000" }, /PORT must be between/],
]) {
  test(`起動時に止める: ${name}`, () => {
    const result = load(extra);

    assert.notEqual(result.status, 0);

    assert.match(result.stderr, message);
  });
}
