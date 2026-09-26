import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import path from "node:path";

import { after, test } from "node:test";

import { removeCreatedTrees, ROOT } from "./helpers/server.ts";

after(removeCreatedTrees);

// docker-compose.yml は env_file を使わず、渡す変数を列挙している。
// サーバーが読む変数を足したのに compose に書き忘れると、.env に書いても黙って効かないため確かめる
test("サーバーが読む環境変数は、docker-compose.yml からコンテナーに渡している", () => {
  const envSource = readFileSync(path.join(ROOT, "src", "config", "env.ts"), "utf8");

  const read = new Set([
    ...[...envSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1] ?? ""),
    ...[...envSource.matchAll(/toInt\("([A-Z0-9_]+)"/g)].map((m) => m[1] ?? ""),
  ]);

  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

  const environment = compose.slice(compose.indexOf("environment:"), compose.indexOf("volumes:"));

  const forwarded = new Set(
    [...environment.matchAll(/^\s+([A-Z0-9_]+):/gm)].map((m) => m[1] ?? ""),
  );

  // コンテナーの中では待ち受けの場所を固定しているため、PORT と HOST は渡さない
  const notForwarded = new Set(["PORT", "HOST"]);

  const missing = [...read].filter((name) => !forwarded.has(name) && !notForwarded.has(name));

  assert.ok(read.size > 5, `found only ${read.size} variables in env.ts`);

  assert.deepEqual(missing, []);
});

// Dockerfile は COPY . . で文脈をまるごと写す。.gitignore で外している秘密のファイルが
// .dockerignore に無いと、手元にあるだけでイメージの層に入る
test(".gitignore で外している秘密のファイルは、Docker のビルドの文脈からも外している", () => {
  const lines = (file: string) =>
    readFileSync(path.join(ROOT, file), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  const dockerignore = new Set(lines(".dockerignore"));

  for (const pattern of [".env", ".env.*", ".npmrc"]) {
    assert.ok(lines(".gitignore").includes(pattern), `.gitignore should list ${pattern}`);

    assert.ok(dockerignore.has(pattern), `.dockerignore should list ${pattern}`);
  }

  // 試験はイメージの中では動かさないため、写さない
  assert.ok(dockerignore.has("test"));
});
