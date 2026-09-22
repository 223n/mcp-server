import assert from "node:assert/strict";

import { symlinkSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { test } from "node:test";

import { createFileTree } from "./helpers/server.js";

// 手元の .env を読ませないため、設定を読み込む前に作業ディレクトリを移す
process.chdir(tmpdir());

const root = createFileTree();

process.env.FILE_ROOTS = root;

const { listFiles, loadFiles } = await import("../src/tools/files.js");

const at = (...parts) => path.join(root, ...parts);

test("許可ルートの中のファイルを読める", async () => {
  const block = await loadFiles([at("app", "src", "Main.php")]);

  assert.match(block, /### File: .*Main\.php \(3 lines\)/);

  assert.match(block, /echo 'hello';/);
});

test("スラッシュ区切りのパスでも読める", async () => {
  const block = await loadFiles([at("app", "src", "Main.php").replace(/\\/g, "/")]);

  assert.match(block, /echo 'hello';/);
});

test("行番号を付けられる", async () => {
  const block = await loadFiles([at("app", "src", "Main.php")], { lineNumbers: true });

  assert.match(block, /1\| <\?php/);
});

test(".env.example は読める", async () => {
  const block = await loadFiles([at("app", ".env.example")]);

  assert.match(block, /SECRET=/);
});

for (const [name, target, expected] of [
  ["許可ルートの外", () => path.join(root, "..", "outside.txt"), /outside the allowed roots/],
  ["..で外へ出る", () => `${root}/app/../../outside.txt`, /outside the allowed roots/],
  [".env", () => at("app", ".env"), /may contain secrets/],
  [".npmrc", () => at("app", ".npmrc"), /may contain secrets/],
  ["app_local.php", () => at("app", "config", "app_local.php"), /may contain secrets/],
  [".git の配下", () => at("app", ".git", "config"), /may contain secrets/],
  ["ディレクトリ", () => at("app", "src"), /Not a regular file/],
  ["バイナリ", () => at("binary.bin"), /Binary file/],
  ["大きすぎるファイル", () => at("big.txt"), /File too large/],
  ["存在しないファイル", () => at("app", "missing.txt"), /File not found/],
]) {
  test(`拒む: ${name}`, async () => {
    await assert.rejects(loadFiles([target()]), expected);
  });
}

test("合計の大きさの上限を超えると拒む", async () => {
  writeFileSync(at("part1.txt"), "a".repeat(50000));

  writeFileSync(at("part2.txt"), "b".repeat(50000));

  await assert.rejects(loadFiles([at("part1.txt"), at("part2.txt")]), /Input too large/);
});

test("シンボリックリンクで許可ルートの外へ出られない", async (t) => {
  const outside = path.join(tmpdir(), `mcp-outside-${process.pid}.txt`);

  writeFileSync(outside, "outside\n");

  try {
    symlinkSync(outside, at("link.txt"));
  } catch (error) {
    t.skip(`シンボリックリンクを作れない環境です（${error.code}）`);

    return;
  }

  await assert.rejects(loadFiles([at("link.txt")]), /outside the allowed roots/);
});

test("path を省くと許可ルートを返す", async () => {
  assert.match(await listFiles({}), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
});

test("直下の一覧を返す", async () => {
  const listing = await listFiles({ path: root });

  assert.match(listing, /app[\\/]$/m);

  assert.match(listing, /binary\.bin \(\d+ KB\)/);
});

test("グロブで絞り込み、秘密のファイルと依存のディレクトリは出さない", async () => {
  const listing = await listFiles({ path: at("app"), pattern: "**/*" });

  assert.match(listing, /Main\.php/);

  assert.match(listing, /util\.js/);

  assert.match(listing, /\.env\.example/);

  for (const hidden of [/\.env \(/, /\.npmrc/, /app_local\.php/, /\.git/, /node_modules/, /vendor/]) {
    assert.doesNotMatch(listing, hidden);
  }
});

test("**/*.php は下の階層の PHP だけを返す", async () => {
  const listing = await listFiles({ path: at("app"), pattern: "**/*.php" });

  assert.match(listing, /Main\.php/);

  assert.doesNotMatch(listing, /util\.js/);
});

test("件数の上限で打ち切る", async () => {
  const listing = await listFiles({ path: root, pattern: "**/*", maxEntries: 2 });

  assert.match(listing, /truncated at 2 entries/);
});

test("一覧でも .. と秘密のディレクトリを拒む", async () => {
  await assert.rejects(listFiles({ path: root, pattern: "../*" }), /must not contain/);

  await assert.rejects(listFiles({ path: at("app", ".git") }), /may contain secrets/);

  await assert.rejects(listFiles({ path: path.join(root, "..") }), /outside the allowed roots/);
});
