import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import path from "node:path";

import { after, test } from "node:test";

import { removeCreatedTrees, ROOT } from "./helpers/server.js";

after(removeCreatedTrees);

// docker-compose.yml は env_file を使わず、渡す変数を列挙している。
// サーバーが読む変数を足したのに compose に書き忘れると、.env に書いても黙って効かないため確かめる
test("サーバーが読む環境変数は、docker-compose.yml からコンテナーに渡している", () => {
  const envSource = readFileSync(path.join(ROOT, "src", "config", "env.js"), "utf8");

  const read = new Set([
    ...[...envSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...envSource.matchAll(/toInt\("([A-Z0-9_]+)"/g)].map((m) => m[1]),
  ]);

  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

  const environment = compose.slice(compose.indexOf("environment:"), compose.indexOf("volumes:"));

  const forwarded = new Set([...environment.matchAll(/^\s+([A-Z0-9_]+):/gm)].map((m) => m[1]));

  // コンテナーの中では待ち受けの場所を固定しているため、PORT と HOST は渡さない
  const notForwarded = new Set(["PORT", "HOST"]);

  const missing = [...read].filter((name) => !forwarded.has(name) && !notForwarded.has(name));

  assert.ok(read.size > 5, `found only ${read.size} variables in env.js`);

  assert.deepEqual(missing, []);
});
