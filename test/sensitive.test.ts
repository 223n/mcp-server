import assert from "node:assert/strict";

import { test } from "node:test";

const { exclusionNote, excludeSensitiveSections, isSensitivePath, unquotePath } = await import(
  "../src/tools/sensitive.ts"
);

test("パスのどれかの段が秘密に当たれば、秘密として扱う", () => {
  for (const value of [
    ".env",
    "config/.env.production",
    ".envrc",
    "deploy/.git-credentials",
    "keys/service-account-prod.json",
    "src/appsettings.Production.json",
    ".mcp.json",
    ".claude/settings.local.json",
    "docker-compose.override.yml",
    ".ssh/config",
    ".aws/credentials",
    "secrets/db.yml",
    "C:\\dev\\app\\.kube\\config",
  ]) {
    assert.equal(isSensitivePath(value), true, value);
  }

  for (const value of [".env.example", "src/app.ts", "docs/secrets-handling.md", "environment.ts"]) {
    assert.equal(isSensitivePath(value), false, value);
  }
});

test("git が引用符で囲んだパスを元に戻す", () => {
  assert.equal(unquotePath('"a/\\343\\201\\202/.env"'), "a/あ/.env");

  assert.equal(unquotePath('"a/tab\\there"'), "a/tab\there");

  assert.equal(unquotePath('"a/quote\\"d"'), 'a/quote"d');

  assert.equal(unquotePath("a/plain"), "a/plain");
});

// 区画を 1 つ作る。本文には、落ちたかどうかを見分ける印を入れる
function section(header: string, marker: string, extra: string[] = []): string {
  return [header, ...extra, "@@ -0,0 +1 @@", `+${marker}`].join("\n");
}

test("差分から秘密のファイルの区画を落とし、落としたことを書き添える", () => {
  const diff = [
    section("diff --git a/src/app.ts b/src/app.ts", "KEEP_APP", ["--- a/src/app.ts", "+++ b/src/app.ts"]),
    section("diff --git a/.env b/.env", "LEAK_ENV", ["--- /dev/null", "+++ b/.env"]),
    section("diff --git a/README.md b/README.md", "KEEP_README", ["--- a/README.md", "+++ b/README.md"]),
  ].join("\n");

  const { text, excluded } = excludeSensitiveSections(diff);

  assert.match(text, /KEEP_APP/);

  assert.match(text, /KEEP_README/);

  assert.doesNotMatch(text, /LEAK_ENV/);

  assert.deepEqual(excluded, [".env"]);

  assert.match(exclusionNote(excluded), /excluded 1 file\(s\) that may contain secrets: \.env/);

  assert.equal(exclusionNote([]), "");
});

test("見出しの形が違っても落とす（空白、引用符、名前の変更、マージの差分）", () => {
  const cases: [string, string][] = [
    // 名前に空白を含むと、git は --- と +++ の行の末尾にタブを足す
    [
      section("diff --git a/my dir/.env b/my dir/.env", "LEAK_SPACE", [
        "--- a/my dir/.env\t",
        "+++ b/my dir/.env\t",
      ]),
      "LEAK_SPACE",
    ],
    // 日本語の名前は 8 進数のバイト列で引用される
    [
      section('diff --git "a/\\343\\201\\202/.env" "b/\\343\\201\\202/.env"', "LEAK_QUOTED", [
        '--- "a/\\343\\201\\202/.env"',
        '+++ "b/\\343\\201\\202/.env"',
      ]),
      "LEAK_QUOTED",
    ],
    // 秘密のファイルから、秘密に当たらない名前へ変えた差分にも、元の中身が載る
    [
      section("diff --git a/.env b/config.txt", "LEAK_RENAME", [
        "similarity index 90%",
        "rename from .env",
        "rename to config.txt",
        "--- a/.env",
        "+++ b/config.txt",
      ]),
      "LEAK_RENAME",
    ],
    // マージの差分の区画も、前の区画に紛れ込ませない
    [section("diff --cc .env", "LEAK_CC", ["--- a/.env", "+++ b/.env"]), "LEAK_CC"],
  ];

  for (const [body, marker] of cases) {
    const diff = [section("diff --git a/app.ts b/app.ts", "KEEP", ["--- a/app.ts", "+++ b/app.ts"]), body].join(
      "\n",
    );

    const { text, excluded } = excludeSensitiveSections(diff);

    assert.doesNotMatch(text, new RegExp(marker), marker);

    assert.match(text, /KEEP/, marker);

    assert.equal(excluded.length, 1, marker);
  }
});

test("本文の中の --- で始まる行は、見出しとして読まない", () => {
  // SQL のコメント "-- a/.env" を消した行は、差分では "--- a/.env" になる
  const diff = [
    "diff --git a/q.sql b/q.sql",
    "--- a/q.sql",
    "+++ b/q.sql",
    "@@ -1,2 +1 @@",
    " select 1;",
    "--- a/.env",
  ].join("\n");

  const { text, excluded } = excludeSensitiveSections(diff);

  assert.equal(text, diff);

  assert.deepEqual(excluded, []);
});
