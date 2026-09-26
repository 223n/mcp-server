import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";

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

const { checkValue, runGit } = await import("../src/git/exec.ts");

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

// files.ts が拒む名前のうち、以前の diff の除外（pathspec の一覧）から漏れていたもの
const SECRET_NAMES = [
  ".env",
  ".envrc",
  ".git-credentials",
  "service-account-prod.json",
  "appsettings.Production.json",
  ".mcp.json",
  "settings.local.json",
  "docker-compose.override.yml",
  ".ssh/config",
  "deploy/secrets/db.yml",
];

test("diff は files.ts と同じ判定で秘密のファイルを外す", async () => {
  const dir = seedRepo("223n/secrets");

  for (const [index, name] of SECRET_NAMES.entries()) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });

    writeFileSync(path.join(dir, name), `LEAKED_${index}\n`);
  }

  writeFileSync(path.join(dir, "app.js"), "export const visible = 1;\n");

  execFileSync("git", ["add", "--all"], { cwd: dir });

  const diff = await gitRead({ repo: "223n/secrets", op: "diff", staged: true });

  assert.doesNotMatch(diff, /LEAKED_/);

  assert.match(diff, /visible = 1/);

  assert.match(diff, new RegExp(`excluded ${SECRET_NAMES.length} file\\(s\\)`));

  const stat = await gitRead({ repo: "223n/secrets", op: "diff", staged: true, stat_only: true });

  assert.match(stat, /app\.js \|/);

  for (const name of SECRET_NAMES) {
    assert.doesNotMatch(stat, new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} +\\|`), name);
  }
});

test("秘密のファイルから名前を変えた差分も外す", async () => {
  const dir = seedRepo("223n/renamed");

  const lines = Array.from({ length: 20 }, (_, i) => `KEY_${i}=RENAMED_SECRET_${i}`);

  writeFileSync(path.join(dir, ".env"), `${lines.join("\n")}\n`);

  execFileSync("git", ["add", ".env"], { cwd: dir });

  execFileSync("git", ["commit", "-m", "env"], { cwd: dir });

  execFileSync("git", ["mv", ".env", "config.txt"], { cwd: dir });

  // 似ている（名前の変更として見つかる）程度に 1 行だけ変える
  writeFileSync(path.join(dir, "config.txt"), `${lines.slice(1).join("\n")}\nKEY_X=changed\n`);

  execFileSync("git", ["add", "config.txt"], { cwd: dir });

  const diff = await gitRead({ repo: "223n/renamed", op: "diff", staged: true });

  assert.doesNotMatch(diff, /RENAMED_SECRET_0/);
});

// 実行されたら印のファイルを作るスクリプトを置き、そのパスを返す
function markerScript(dir: string, name: string, marker: string): string {
  const script = path.join(dir, name);

  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);

  chmodSync(script, 0o755);

  return script;
}

const unixOnly = { skip: process.platform === "win32" ? "シェルのスクリプトを使うため" : false };

test(".git/config に許可していない鍵があれば、git を動かさずに拒む", unixOnly, async () => {
  const dir = seedRepo("223n/tampered");

  const marker = path.join(dir, "..", "tampered-ran");

  const script = markerScript(path.join(dir, ".."), "tampered.sh", marker);

  const cases: [string, string][] = [
    ["core.fsmonitor", script],
    ["core.hooksPath", path.dirname(script)],
    ["diff.external", script],
    ["core.worktree", "/"],
    ["include.path", "/tmp/elsewhere.gitconfig"],
    ["url.https://example.invalid/.insteadOf", "https://github.com/"],
    ["filter.x.clean", script],
    ["credential.helper", script],
    ["remote.upstream.url", "https://example.invalid/x.git"],
  ];

  for (const [key, value] of cases) {
    execFileSync("git", ["config", "--local", key, value], { cwd: dir });

    for (const op of ["status", "diff"] as const) {
      await assert.rejects(
        gitRead({ repo: "223n/tampered", op }),
        (error: Error) => error.message.includes("does not allow") && error.message.toLowerCase().includes(key.toLowerCase()),
        `${key} (${op})`,
      );
    }

    await assert.rejects(
      gitWrite({ repo: "223n/tampered", op: "commit", message: "x" }),
      /does not allow/,
      key,
    );

    execFileSync("git", ["config", "--local", "--unset-all", key], { cwd: dir });
  }

  assert.equal(existsSync(marker), false);

  // 鍵を消せば、また読める
  assert.match(await gitRead({ repo: "223n/tampered", op: "status" }), /## main/);
});

test("origin の URL が取得先と違えば拒み、同じなら通す", async () => {
  const dir = seedRepo("223n/origin-check");

  execFileSync("git", ["remote", "add", "origin", "https://github.com/223n/other.git"], { cwd: dir });

  await assert.rejects(gitRead({ repo: "223n/origin-check", op: "status" }), /remote\.origin\.url/);

  execFileSync("git", ["remote", "set-url", "origin", "https://github.com/223n/origin-check.git"], { cwd: dir });

  // clone と push --set-upstream が書く鍵は通す
  execFileSync("git", ["config", "--local", "branch.main.remote", "origin"], { cwd: dir });

  execFileSync("git", ["config", "--local", "branch.main.merge", "refs/heads/main"], { cwd: dir });

  execFileSync("git", ["config", "--local", "remote.origin.tagOpt", "--no-tags"], { cwd: dir });

  assert.match(await gitRead({ repo: "223n/origin-check", op: "status" }), /## main/);
});

test("許可リストを通り抜けても、フックと fsmonitor はコマンドの側の設定で止まる", unixOnly, async () => {
  const dir = seedRepo("223n/overrides");

  const marker = path.join(dir, "..", "overrides-ran");

  const hooks = path.join(dir, "..", "overrides-hooks");

  mkdirSync(hooks, { recursive: true });

  markerScript(hooks, "pre-commit", marker);

  const script = markerScript(hooks, "fsmonitor.sh", marker);

  execFileSync("git", ["config", "--local", "core.hooksPath", hooks], { cwd: dir });

  execFileSync("git", ["config", "--local", "core.fsmonitor", script], { cwd: dir });

  writeFileSync(path.join(dir, "note.md"), "# note\n");

  // 許可リストの確かめを通らない runGit を直に呼び、HARDENED_CONFIG だけで止まることを確かめる
  const status = await runGit(["-C", dir, "status", "--short"]);

  assert.equal(status.code, 0);

  await runGit(["-C", dir, "add", "note.md"]);

  const commit = await runGit(["-C", dir, "commit", "-m", "note"], {
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

  assert.equal(commit.code, 0, commit.stderr);

  assert.equal(existsSync(marker), false);
});

test("秘密のファイルの区画の途中で切り詰められても、切り詰めたことは残す", async () => {
  const dir = seedRepo("223n/truncated");

  // 名前の順で .env が先に来るため、6 万文字の切り詰めは .env の区画の中で起きる
  writeFileSync(path.join(dir, ".env"), `${"BIG_SECRET=x\n".repeat(8000)}`);

  writeFileSync(path.join(dir, "zz.js"), "export const z = 1;\n");

  execFileSync("git", ["add", "--all"], { cwd: dir });

  const diff = await gitRead({ repo: "223n/truncated", op: "diff", staged: true });

  assert.doesNotMatch(diff, /BIG_SECRET/);

  assert.match(diff, /truncated at \d+ characters/);

  assert.match(diff, /excluded 1 file\(s\) that may contain secrets: \.env/);
});
