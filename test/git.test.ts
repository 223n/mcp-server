import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { after, test } from "node:test";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

// 手元の .env を読ませないため、設定を読み込む前に作業ディレクトリを移す
process.chdir(WORK_DIR);

after(removeCreatedTrees);

const cloneRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-clone-")));

process.env.CLONE_ROOT = cloneRoot;

process.env.GIT_ALLOWED_OWNERS = "223n,allowed-owner";

process.env.GIT_USER_NAME = "test";

process.env.GIT_USER_EMAIL = "test@example.com";

const {
  cloneFailureHint,
  cloneReady,
  gitClone,
  gitRead,
  gitWrite,
  initClone,
  isProtectedBranch,
  parseSlug,
} = await import("../src/tools/git.ts");

const { checkValue } = await import("../src/git/exec.ts");

const silent = () => {};

// 取得済みのリポジトリの代わりに、その場で git init したものを置く
function seedRepo(slug: string): string {
  const dir = path.join(cloneRoot, ...slug.split("/"));

  mkdirSync(dir, { recursive: true });

  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  run("init", "--initial-branch=main");

  run("config", "user.name", "test");

  run("config", "user.email", "test@example.com");

  writeFileSync(path.join(dir, "README.md"), "# seed\n");

  run("add", "README.md");

  run("commit", "-m", "first");

  return dir;
}

test("CLONE_ROOT が実在して書けるなら有効になる", async () => {
  assert.equal(await initClone({ warn: silent }), true);

  assert.equal(cloneReady(), true);
});

const slugCases: [string, string, RegExp][] = [
  ["パスの区切りが多すぎる", "a/b/c", /must be "owner\/repo"/],
  ["区切りが無い", "repo", /must be "owner\/repo"/],
  ["..", "../../etc", /must be "owner\/repo"/],
  ["owner が ..", "../repo", /Invalid owner name/],
  ["repo が ..", "223n/..", /Invalid repo name/],
  ["repo が .", "223n/.", /Invalid repo name/],
  ["先頭がドット", "223n/.hidden", /Invalid repo name/],
  ["末尾がドット", "223n/repo.", /Invalid repo name/],
  ["Windows の装置名", "223n/NUL", /Invalid repo name/],
  ["拡張子つきの装置名", "223n/com1.js", /Invalid repo name/],
  [".git で終わる", "223n/repo.git", /must not end with/],
  ["owner に記号", "own;er/repo", /Invalid owner name/],
  ["repo に空白", "223n/re po", /Invalid repo name/],
  ["絶対パス", "/etc/passwd", /must be "owner\/repo"/],
  ["URL", "https://github.com/223n/repo", /must be "owner\/repo"/],
];

for (const [name, value, expected] of slugCases) {
  test(`repo を拒む: ${name}`, () => {
    assert.throws(() => parseSlug(value), expected);
  });
}

test("正しい owner/repo は通る", () => {
  assert.deepEqual(parseSlug(" 223n/mcp-server "), {
    owner: "223n",
    repo: "mcp-server",
    slug: "223n/mcp-server",
  });
});

test("許可していない owner の取得を拒む", async () => {
  await assert.rejects(gitClone({ repo: "someone-else/repo" }), /not in GIT_ALLOWED_OWNERS/);
});

test("取得していないリポジトリを読もうとしたら、その旨を返す", async () => {
  await assert.rejects(gitRead({ repo: "223n/missing", op: "status" }), /has not been cloned yet/);
});

for (const [name, value] of [
  ["オプションに見える値", "--upload-pack=touch /tmp/pwned"],
  ["空", ""],
  ["改行", "main\n--exec=x"],
  ["NUL", "main\u0000"],
]) {
  test(`値として拒む: ${name}`, () => {
    assert.throws(() => checkValue(value, "branch"), /Invalid value/);
  });
}

test("守るブランチを見分ける", () => {
  for (const branch of ["main", "MAIN", "master", "develop", "Develop"]) {
    assert.equal(isProtectedBranch(branch), true, branch);
  }

  for (const branch of ["feature/x", "release/v1.0.0", "maintenance"]) {
    assert.equal(isProtectedBranch(branch), false, branch);
  }
});

test("取得済みのリポジトリを読める", async () => {
  seedRepo("223n/seed");

  const status = await gitRead({ repo: "223n/seed", op: "status" });

  assert.match(status, /## main/);

  const log = await gitRead({ repo: "223n/seed", op: "log" });

  assert.match(log, /first/);

  const branches = await gitRead({ repo: "223n/seed", op: "branches" });

  assert.match(branches, /main/);

  const show = await gitRead({ repo: "223n/seed", op: "show" });

  assert.match(show, /first/);

  // show は中身を返さない（README.md の本文が出ない）
  assert.doesNotMatch(show, /# seed/);
});

test("オプションに見える ref は拒む", async () => {
  await assert.rejects(
    gitRead({ repo: "223n/seed", op: "diff", ref: "--cached" }),
    /Invalid value for ref/,
  );
});

test("diff は秘密のファイルを外す", async () => {
  const dir = path.join(cloneRoot, "223n", "seed");

  writeFileSync(path.join(dir, ".env"), "SECRET=leaked\n");

  writeFileSync(path.join(dir, "app.js"), "export const x = 1;\n");

  execFileSync("git", ["add", "--all"], { cwd: dir });

  const diff = await gitRead({ repo: "223n/seed", op: "diff", staged: true });

  assert.doesNotMatch(diff, /SECRET=leaked/);

  assert.match(diff, /app\.js/);
});

test("守るブランチへの push を拒む", async () => {
  for (const branch of ["main", "develop", "master"]) {
    await assert.rejects(
      gitWrite({ repo: "223n/seed", op: "push", branch }),
      /Refusing to push/,
      branch,
    );
  }
});

test("守る名前のブランチは作らせない", async () => {
  await assert.rejects(
    gitWrite({ repo: "223n/seed", op: "create_branch", branch: "develop" }),
    /Refusing to create/,
  );
});

test("ブランチを作り、staging して commit できる", async () => {
  const created = await gitWrite({
    repo: "223n/seed",
    op: "create_branch",
    branch: "feature/from-test",
  });

  assert.ok(created.length >= 0);

  writeFileSync(path.join(cloneRoot, "223n", "seed", "note.md"), "# note\n");

  const staged = await gitWrite({ repo: "223n/seed", op: "add", paths: ["note.md"] });

  assert.match(staged, /note\.md/);

  const committed = await gitWrite({ repo: "223n/seed", op: "commit", message: "add note" });

  assert.match(committed, /add note/);

  assert.match(committed, /test@example\.com/);
});

test("checked out していないブランチの push を拒む", async () => {
  await assert.rejects(
    gitWrite({ repo: "223n/seed", op: "push", branch: "feature/other" }),
    /The checked-out branch is/,
  );
});

test("リポジトリの外を指す staging を拒む", async () => {
  for (const value of ["../outside.txt", "a/../../b", "..\\windows"]) {
    await assert.rejects(
      gitWrite({ repo: "223n/seed", op: "add", paths: [value] }),
      /must stay inside the repository/,
      value,
    );
  }
});

test("add にパスを渡さなければ拒む", async () => {
  await assert.rejects(gitWrite({ repo: "223n/seed", op: "add", paths: [] }), /`paths` is required/);
});

test("空の commit メッセージを拒む", async () => {
  await assert.rejects(
    gitWrite({ repo: "223n/seed", op: "commit", message: "   " }),
    /`message` is required/,
  );
});

test("知らない op を拒む", async () => {
  // 型の上では通らない op を、わざと実行時に渡して拒まれることを確かめる
  await assert.rejects(gitRead({ repo: "223n/seed", op: "archive" as never }), /Unknown op/);

  await assert.rejects(gitWrite({ repo: "223n/seed", op: "reset" as never }), /Unknown op/);
});

test("CLONE_ROOT が無ければ git のツールごと無効にする", async () => {
  const { config } = await import("../src/config/config.ts");

  const saved = config.cloneRoot;

  config.cloneRoot = {
    hostPrefix: "x",
    hostLabel: "X",
    localPath: path.join(cloneRoot, "missing"),
  };

  assert.equal(await initClone({ warn: silent }), false);

  assert.equal(cloneReady(), false);

  config.cloneRoot = saved;

  assert.equal(await initClone({ warn: silent }), true);
});

test("トークンが無いときの clone の失敗に、原因の手がかりを足す", async () => {
  const { config } = await import("../src/config/config.ts");

  const saved = config.githubToken;

  config.githubToken = "";

  try {
    // GitHub は認証の無い private リポジトリにも 404 を返す
    const hinted = cloneFailureHint("remote: Repository not found.", "223n/secret");

    assert.match(hinted, /Repository not found/);

    assert.match(hinted, /GITHUB_MCP_TOKEN is not set/);

    assert.match(hinted, /223n\/secret/);

    // 認証と関係のない失敗には足さない
    assert.equal(
      cloneFailureHint("fatal: destination path already exists", "223n/x"),
      "fatal: destination path already exists",
    );
  } finally {
    config.githubToken = saved;
  }
});

test("トークンがあるときは手がかりを足さない", async () => {
  const { config } = await import("../src/config/config.ts");

  const saved = config.githubToken;

  config.githubToken = "github_pat_example";

  try {
    assert.equal(
      cloneFailureHint("remote: Repository not found.", "223n/x"),
      "remote: Repository not found.",
    );
  } finally {
    config.githubToken = saved;
  }
});
