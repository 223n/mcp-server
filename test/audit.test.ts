import assert from "node:assert/strict";

import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

process.chdir(WORK_DIR);

after(removeCreatedTrees);

const modules = await import("../src/audit.ts");

const { audit, auditedCall, auditFields, currentIdentity, setDefaultIdentity, withIdentity } = modules;

const { config } = await import("../src/config/config.ts");

// 監査は stderr に出る。console.error を差し替えて中身を見る
function capture<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];

  const original = console.error;

  console.error = (line: unknown) => lines.push(String(line));

  try {
    return { result: run(), lines };
  } finally {
    console.error = original;
  }
}

async function captureAsync<T>(
  run: () => Promise<T>,
): Promise<{ result: T | Error; lines: string[] }> {
  const lines: string[] = [];

  const original = console.error;

  console.error = (line: unknown) => lines.push(String(line));

  try {
    return { result: await run().catch((error: unknown) => error as Error), lines };
  } finally {
    console.error = original;
  }
}

test("中身そのものは記録しない", () => {
  const fields = auditFields({
    prompt: "秘密の指示",
    code: "secret code",
    system: "secret system",
    context: "secret context",
    message: "secret message",
    body: "secret body",
    error: "secret error",
    model: "qwen2.5-coder:14b",
    op: "push",
  });

  for (const key of ["prompt", "code", "system", "context", "message", "body", "error"]) {
    assert.equal(key in fields, false, key);
  }

  assert.equal(fields.model, "qwen2.5-coder:14b");

  assert.equal(fields.op, "push");
});

test("渡したファイルのパスは残す", () => {
  const fields = auditFields({ files: ["C:\\dev\\a.php", "C:\\dev\\b.php"], paths: ["x.md"] });

  assert.deepEqual(fields.files, ["C:\\dev\\a.php", "C:\\dev\\b.php"]);

  assert.deepEqual(fields.paths, ["x.md"]);
});

test("パスが多いときは件数を添えて切る", () => {
  const files = Array.from({ length: 30 }, (_, i) => `C:\\dev\\f${i}.php`);

  const fields = auditFields({ files });

  assert.equal((fields.files as string[]).length, 20);

  assert.equal(fields.files_total, 30);
});

test("長い値は切り詰める", () => {
  const fields = auditFields({ output_name: "a".repeat(500) });

  const name = fields.output_name;

  // 文字列であることを先に確かめる。
  // String() で包むと、値が丸ごと落ちたときも "undefined" の 9 文字になって通ってしまう
  assert.ok(typeof name === "string", `output_name が文字列ではありません: ${String(name)}`);

  assert.ok(name.length <= 201, String(name.length));
});

test("inline_files は件数だけにする", () => {
  const fields = auditFields({
    inline_files: [
      { name: "a.md", content: "秘密1" },
      { name: "b.md", content: "秘密2" },
    ],
  });

  assert.equal(fields.inline_files, 2);

  assert.equal(JSON.stringify(fields).includes("秘密"), false);
});

test("知らない鍵は落とす", () => {
  assert.deepEqual(auditFields({ whatever: "x", secret_key: "y" }), {});
});

test("成功した呼び出しを 1 行の JSON で残す", async () => {
  const { lines } = await captureAsync(() =>
    auditedCall("ollama_chat", { prompt: "秘密", model: "m" }, async () => "done"),
  );

  assert.equal(lines.length, 1);

  const entry = JSON.parse(lines[0] ?? "{}");

  assert.equal(entry.kind, "tool");

  assert.equal(entry.tool, "ollama_chat");

  assert.equal(entry.ok, true);

  assert.equal(entry.args.model, "m");

  assert.equal("prompt" in entry.args, false);

  assert.ok(typeof entry.ms === "number");

  assert.ok(entry.ts);
});

test("失敗した呼び出しも残し、例外はそのまま投げ直す", async () => {
  const { result, lines } = await captureAsync(() =>
    auditedCall("git_write", { op: "push", branch: "main" }, async () => {
      throw new Error("Refusing to push to \"main\"");
    }),
  );

  assert.ok(result instanceof Error);

  const entry = JSON.parse(lines[0] ?? "{}");

  assert.equal(entry.ok, false);

  assert.equal(entry.tool, "git_write");

  assert.equal(entry.args.branch, "main");

  assert.match(entry.error, /Refusing to push/);
});

test("識別子を呼び出しの間だけ持ち回る", async () => {
  setDefaultIdentity("stdio");

  assert.equal(currentIdentity(), "stdio");

  await withIdentity("me@example.com", async () => {
    assert.equal(currentIdentity(), "me@example.com");

    // await をまたいでも保たれる
    await new Promise((resolve) => setTimeout(resolve, 1));

    assert.equal(currentIdentity(), "me@example.com");
  });

  assert.equal(currentIdentity(), "stdio");

  setDefaultIdentity("-");
});

test("識別子は毎行に入る", () => {
  const { lines } = capture(() =>
    withIdentity("you@example.com", () => audit({ kind: "resource", ok: true, ms: 0 })),
  );

  assert.equal(JSON.parse(lines[0] ?? "{}").identity, "you@example.com");
});

describe("監査ログのファイル", () => {
  const { initAuditLog, pruneAuditLogs } = modules;

  let saved: { dir: string; roots: typeof config.fileRoots; days: number };

  let dir: string;

  const warnings: string[] = [];

  const warn = (message: string) => warnings.push(message);

  before(() => {
    saved = { dir: config.auditLogDir, roots: config.fileRoots, days: config.auditRetentionDays };
  });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-audit-")));

    config.auditLogDir = dir;

    config.fileRoots = [];

    warnings.length = 0;
  });

  afterEach(() => {
    config.auditLogDir = "";

    initAuditLog({ warn });

    rmSync(dir, { recursive: true, force: true });
  });

  after(() => {
    config.auditLogDir = saved.dir;

    config.fileRoots = saved.roots;

    config.auditRetentionDays = saved.days;
  });

  test("設定すると、標準エラーに加えて日付ごとのファイルに 1 行ずつ追記する", () => {
    assert.equal(initAuditLog({ warn }), true);

    const { lines } = capture(() => {
      audit({ kind: "tool", tool: "git_write", ok: true, ms: 1 });

      audit({ kind: "resource", ok: false, ms: 2, path: "/work/dev/x" });
    });

    assert.equal(lines.length, 2);

    const files = readdirSync(dir);

    assert.equal(files.length, 1);

    assert.match(files[0] ?? "", /^audit-\d{8}\.jsonl$/);

    const written = readFileSync(path.join(dir, files[0] ?? ""), "utf8").trim().split("\n");

    assert.deepEqual(written, lines);
  });

  test("FILE_ROOTS の中は、ファイルのツールから読めてしまうため拒む", () => {
    config.fileRoots = [{ hostPrefix: dir.toLowerCase(), hostLabel: dir, localPath: dir }];

    assert.equal(initAuditLog({ warn }), false);

    assert.match(warnings.join("\n"), /inside FILE_ROOTS/);
  });

  test("無い場所と相対パスは、使わずに知らせる", () => {
    config.auditLogDir = path.join(dir, "missing");

    assert.equal(initAuditLog({ warn }), false);

    config.auditLogDir = "relative/audit";

    assert.equal(initAuditLog({ warn }), false);

    assert.match(warnings.join("\n"), /does not exist/);

    assert.match(warnings.join("\n"), /absolute path/);
  });

  test("残す日数より古い監査ログだけを消し、ほかのファイルには触れない", () => {
    assert.equal(initAuditLog({ warn }), true);

    config.auditRetentionDays = 30;

    for (const name of ["audit-20260801.jsonl", "audit-20260830.jsonl", "audit-20260926.jsonl", "notes.txt"]) {
      writeFileSync(path.join(dir, name), "{}\n");
    }

    const removed = pruneAuditLogs(new Date("2026-09-26T12:00:00Z"));

    assert.deepEqual(removed, ["audit-20260801.jsonl"]);

    assert.deepEqual(readdirSync(dir).sort(), ["audit-20260830.jsonl", "audit-20260926.jsonl", "notes.txt"]);
  });
});
