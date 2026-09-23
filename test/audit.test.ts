import assert from "node:assert/strict";

import { after, test } from "node:test";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

process.chdir(WORK_DIR);

after(removeCreatedTrees);

const { audit, auditedCall, auditFields, currentIdentity, setDefaultIdentity, withIdentity } =
  await import("../src/audit.ts");

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

  assert.ok(String(fields.output_name).length <= 201, String(String(fields.output_name).length));
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
