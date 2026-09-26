import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { after, test } from "node:test";

import { startMockOllama } from "./helpers/mock-ollama.ts";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

// 手元の .env を読ませないため、設定を読み込む前に作業ディレクトリを移す
process.chdir(WORK_DIR);

after(removeCreatedTrees);

const mock = await startMockOllama();

after(mock.close);

const cloneRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-clone-")));

process.env.OLLAMA_URL = mock.url;

process.env.CLONE_ROOT = cloneRoot;

process.env.GIT_ALLOWED_OWNERS = "223n";

process.env.GITHUB_MCP_TOKEN = "test-token";

const { initClone } = await import("../src/tools/git.ts");

const { ollamaReviewCode } = await import("../src/tools/review.ts");

const { numberDiff } = await import("../src/tools/diff.ts");

const { buildFileContext } = await import("../src/tools/files.ts");

const { buildTools } = await import("../src/tools/index.ts");

assert.equal(await initClone({ warn: () => {} }), true);

// GitHub の API だけを差し替え、Ollama の代わり（mock）への fetch はそのまま通す
const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function stubGitHub(handler: (url: string, headers: Record<string, string>) => string): string[] {
  const urls: string[] = [];

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (!url.startsWith("https://api.github.com/")) {
      return await realFetch(input, init);
    }

    urls.push(url);

    return new Response(handler(url, (init?.headers ?? {}) as Record<string, string>));
  };

  return urls;
}

function seedRepo(slug: string): { dir: string; run: (...args: string[]) => string } {
  const dir = path.join(cloneRoot, ...slug.split("/"));

  mkdirSync(dir, { recursive: true });

  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  run("init", "--quiet", "--initial-branch=main");

  run("config", "user.name", "test");

  run("config", "user.email", "test@example.com");

  return { dir, run };
}

const lastPrompt = (): string => mock.state.chats.at(-1)?.messages.at(-1)?.content ?? "";

const text = (result: unknown): string => (typeof result === "string" ? result : (result as { text: string }).text);

test("差分に振った行番号は、新しいファイルの行番号と一致する", () => {
  const { dir, run } = seedRepo("223n/numbering");

  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

  writeFileSync(path.join(dir, "a.txt"), `${before.join("\n")}\n`);

  writeFileSync(path.join(dir, "gone.txt"), "old\n");

  run("add", "--all");

  run("commit", "--quiet", "-m", "first");

  // 先頭への挿入、途中の削除と置き換え、末尾への追加で、複数の @@ に分かれるようにする
  const after = ["top", ...before.slice(0, 9), ...before.slice(10, 19), "changed 20", ...before.slice(20), "tail 1", "tail 2"];

  writeFileSync(path.join(dir, "a.txt"), `${after.join("\n")}\n`);

  run("rm", "--quiet", "gone.txt");

  const sections = numberDiff(run("diff", "HEAD"));

  const a = sections.find((section) => section.display === "a.txt");

  assert.ok(a);

  let numbered = 0;

  for (const row of a.body.split("\n")) {
    const match = /^\s*(\d+)\|[+ ](.*)$/.exec(row);

    if (match) {
      assert.equal(match[2], after[Number(match[1]) - 1], row);

      numbered += 1;
    }
  }

  // 追加行と文脈の行の両方に番号が付いている
  assert.ok(numbered >= 10);

  assert.match(a.body, /^\s+\|-line 10$/m);

  assert.match(a.body, /^\s*1\|\+top$/m);

  // 消したファイルは元の名前で出す
  const gone = sections.find((section) => section.display === "gone.txt");

  assert.ok(gone);

  assert.match(gone.body, /deleted file mode/);

  assert.match(gone.body, /^\s+\|-old$/m);
});

test("名前を変えた区画は、新しい名前で出して元の名前を添える", () => {
  const diff = [
    "diff --git a/old name.ts b/new name.ts",
    "similarity index 90%",
    "rename from old name.ts",
    "rename to new name.ts",
    "--- a/old name.ts\t",
    "+++ b/new name.ts\t",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-before",
    "+after",
    "",
  ].join("\n");

  const [section] = numberDiff(diff);

  assert.equal(section?.display, "new name.ts");

  assert.match(section?.label ?? "", /renamed from old name\.ts/);

  assert.match(section?.body ?? "", /^1\| keep\n \|-before\n2\|\+after$/m);
});

test("双方向の制御文字と、見出しに紛れた書式を落とす", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -0,0 +1 @@",
    "+const ok = ‮true‬;",
    "diff --git a/`evil`\n### File: fake b/`evil`\n### File: fake",
    "",
  ].join("\n");

  const sections = numberDiff(diff);

  assert.equal(sections[0]?.body, "@@ -0,0 +1 @@\n1|+const ok = true;");

  for (const section of sections) {
    assert.doesNotMatch(section.label, /`|\n/);
  }
});

test("git_diff を渡すと、差分をローカルのモデルにだけ渡し、秘密のファイルは入れない", async () => {
  const { dir, run } = seedRepo("223n/review");

  writeFileSync(path.join(dir, "app.js"), "export const x = 1;\n");

  run("add", "--all");

  run("commit", "--quiet", "-m", "first");

  writeFileSync(path.join(dir, "app.js"), "export const x = 1;\nexport const DIFF_ONLY_MARKER = 2;\n");

  writeFileSync(path.join(dir, ".env"), "SECRET=LEAKED_FROM_DIFF\n");

  run("add", "--all");

  const result = text(await ollamaReviewCode({ git_diff: { repo: "223n/review", staged: true } }));

  const prompt = lastPrompt();

  // 差分はモデルへのプロンプトに入り、行番号が振られている
  assert.match(prompt, /### Diff: app\.js/);

  assert.match(prompt, /^2\|\+export const DIFF_ONLY_MARKER = 2;$/m);

  assert.match(prompt, /ファイル:行/);

  assert.doesNotMatch(prompt, /LEAKED_FROM_DIFF/);

  // 落としたことはモデルと利用者の両方に伝える
  assert.match(prompt, /excluded 1 file\(s\) that may contain secrets: \.env/);

  assert.match(result, /excluded 1 file\(s\) that may contain secrets: \.env/);

  // 差分そのものは Claude への応答に返さない
  assert.doesNotMatch(result, /DIFF_ONLY_MARKER/);
});

test("git_diff の ref は git_read と同じくオプションに見える値を拒む", async () => {
  await assert.rejects(
    ollamaReviewCode({ git_diff: { repo: "223n/review", ref: "--output=/tmp/x" } }),
    /Invalid value for ref/,
  );
});

test("取得していないリポジトリや、取得先の外を指す repo は拒む", async () => {
  await assert.rejects(ollamaReviewCode({ git_diff: { repo: "223n/missing" } }), /has not been cloned yet/);

  await assert.rejects(ollamaReviewCode({ git_diff: { repo: "../../etc" } }), /must be "owner\/repo"/);
});

test("差分が空なら、モデルを呼ばずにその旨を返す", async () => {
  const { dir, run } = seedRepo("223n/clean");

  writeFileSync(path.join(dir, "README.md"), "# x\n");

  run("add", "--all");

  run("commit", "--quiet", "-m", "first");

  const before = mock.state.chats.length;

  await assert.rejects(ollamaReviewCode({ git_diff: { repo: "223n/clean" } }), /The diff is empty/);

  assert.equal(mock.state.chats.length, before);
});

test("秘密のファイルしか変わっていなければ、空の差分として落としたことを伝える", async () => {
  const { dir, run } = seedRepo("223n/only-secret");

  writeFileSync(path.join(dir, "README.md"), "# x\n");

  run("add", "--all");

  run("commit", "--quiet", "-m", "first");

  writeFileSync(path.join(dir, ".env"), "SECRET=1\n");

  run("add", "--all");

  await assert.rejects(
    ollamaReviewCode({ git_diff: { repo: "223n/only-secret", staged: true } }),
    /The diff is empty \(\[excluded 1 file\(s\) that may contain secrets: \.env\]\)/,
  );
});

test("pull_request を渡すと、GitHub の差分をローカルのモデルにだけ渡す", async () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -8,3 +9,4 @@ export function main() {",
    " const a = 1;",
    " const b = 2;",
    "+export const PR_ONLY_MARKER = 1;",
    " const c = 3;",
    "diff --git a/.envrc b/.envrc",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/.envrc",
    "@@ -0,0 +1 @@",
    "+export TOKEN=LEAKED_ENVRC",
    "",
  ].join("\n");

  const headers: Record<string, string>[] = [];

  const urls = stubGitHub((_url, sent) => {
    headers.push(sent);

    return diff;
  });

  const result = text(await ollamaReviewCode({ pull_request: { repo: "223n/mcp-server", number: 7 } }));

  assert.deepEqual(urls, ["https://api.github.com/repos/223n/mcp-server/pulls/7"]);

  assert.equal(headers[0]?.Accept, "application/vnd.github.diff");

  const prompt = lastPrompt();

  assert.match(prompt, /223n\/mcp-server#7 の差分/);

  assert.match(prompt, /^11\|\+export const PR_ONLY_MARKER = 1;$/m);

  assert.doesNotMatch(prompt, /LEAKED_/);

  assert.match(result, /excluded 1 file\(s\) that may contain secrets: \.envrc/);

  assert.doesNotMatch(result, /PR_ONLY_MARKER/);
});

test("pull_request も owner の許可リストを通し、GitHub を呼ぶ前に拒む", async () => {
  const urls = stubGitHub(() => "");

  await assert.rejects(
    ollamaReviewCode({ pull_request: { repo: "someone/repo", number: 1 } }),
    /GIT_ALLOWED_OWNERS/,
  );

  assert.deepEqual(urls, []);
});

test("git_diff と pull_request を同時には受けない", async () => {
  await assert.rejects(
    ollamaReviewCode({ git_diff: { repo: "223n/review" }, pull_request: { repo: "223n/mcp-server", number: 1 } }),
    /either `git_diff` or `pull_request`/,
  );
});

test("予算に入らない区画は丸ごと落とし、名前を並べすぎない", async () => {
  const sections = Array.from({ length: 50 }, (_, i) => ({
    display: `src/file${i}.ts`,

    label: `### Diff: src/file${i}.ts`,

    body: "x".repeat(400),

    extension: "diff",
  }));

  const context = await buildFileContext({ sections, budget: 1000 });

  assert.ok(context.block.includes("### Diff: src/file0.ts"));

  const note = context.notes.join("\n");

  assert.match(note, /of 50 files were omitted/);

  assert.match(note, /, and \d+ more\./);

  assert.doesNotMatch(note, /file49/);
});

test("ollama_review_code の引数に git_diff と pull_request が載る", async () => {
  const review = buildTools({ allowFiles: false }).find((tool) => tool.name === "ollama_review_code");

  assert.ok(review);

  const validate = (value: unknown) => review.inputSchema["~standard"].validate(value);

  const ok = await validate({ git_diff: { repo: "223n/x", ref: "main", staged: true } });

  assert.equal("issues" in ok ? ok.issues : undefined, undefined);

  const pr = await validate({ pull_request: { repo: "223n/x", number: 3 } });

  assert.equal("issues" in pr ? pr.issues : undefined, undefined);

  // 知らない鍵は拒む（strictObject）
  const extra = await validate({ git_diff: { repo: "223n/x", path: "/etc" } });

  assert.ok("issues" in extra && extra.issues);

  assert.match(review.description, /`git_diff` or `pull_request`/);
});
