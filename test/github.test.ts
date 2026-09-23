import assert from "node:assert/strict";

import { after, test } from "node:test";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

// 手元の .env を読ませないため、設定を読み込む前に作業ディレクトリを移す
process.chdir(WORK_DIR);

after(removeCreatedTrees);

process.env.GITHUB_MCP_TOKEN = "test-token";

process.env.GIT_ALLOWED_OWNERS = "223n";

const { githubRead, githubReady, githubWrite } = await import("../src/tools/github.ts");

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

/** 差し替えた fetch が受け取った 1 回分。試験が確かめる部分だけを取り出して持つ */
type FetchCall = {
  url: string;
  init: { method?: string; headers: Record<string, string>; body?: string };
};

type StubReply = { status?: number; body?: string } | undefined;

// fetch を差し替えて、呼ばれた内容と返す内容を試験から決める
function stubFetch(handler: (call: FetchCall) => StubReply): FetchCall[] {
  const calls: FetchCall[] = [];

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),

      init: {
        method: init?.method,

        headers: (init?.headers ?? {}) as Record<string, string>,

        body: typeof init?.body === "string" ? init.body : undefined,
      },
    };

    calls.push(call);

    const { status = 200, body = "{}" } = handler(call) ?? {};

    return new Response(body, { status });
  };

  return calls;
}

test("トークンがあれば有効になる", () => {
  assert.equal(githubReady(), true);
});

const repoCases: [string, string, RegExp][] = [
  ["許可していない owner", "someone/repo", /not in GIT_ALLOWED_OWNERS/],
  ["区切りが多すぎる", "223n/a/b", /must be "owner\/repo"/],
  ["URL", "https://github.com/223n/repo", /must be "owner\/repo"/],
  ["owner に記号", "22;3n/repo", /must be "owner\/repo"/],
];

for (const [name, repo, expected] of repoCases) {
  test(`repo を拒む: ${name}`, async () => {
    await assert.rejects(githubRead({ repo, op: "pr_list" }), expected);
  });
}

test("番号は正の整数だけを受ける", async () => {
  stubFetch(() => ({ body: "{}" }));

  // 型の上では number だけだが、実行時に別の形が来ても拒むことを確かめる
  for (const value of [0, -1, 1.5, undefined, "3"]) {
    await assert.rejects(
      githubRead({ repo: "223n/repo", op: "pr_view", number: value as never }),
      /positive integer/,
    );
  }
});

test("pr_list は 1 行ずつにまとめて返す", async () => {
  const calls = stubFetch(() => ({
    body: JSON.stringify([
      {
        number: 8,
        state: "open",
        user: { login: "223n" },
        head: { ref: "feature/x" },
        base: { ref: "develop" },
        title: "ファイル渡しを広げる",
      },
    ]),
  }));

  const text = await githubRead({ repo: "223n/mcp-server", op: "pr_list" });

  assert.match(text, /#8/);

  assert.match(text, /feature\/x -> develop/);

  assert.match(text, /ファイル渡しを広げる/);

  assert.match(calls[0]!.url, /\/repos\/223n\/mcp-server\/pulls\?state=open/);

  assert.equal(calls[0]!.init.headers.Authorization, "Bearer test-token");
});

test("一致が無ければ、空ではなくその旨を返す", async () => {
  stubFetch(() => ({ body: "[]" }));

  assert.match(await githubRead({ repo: "223n/mcp-server", op: "pr_list" }), /No pull requests matched/);
});

test("issue_list は Pull Request を混ぜない", async () => {
  stubFetch(() => ({
    body: JSON.stringify([
      { number: 1, state: "open", user: { login: "223n" }, title: "本物のIssue" },
      { number: 2, state: "open", user: { login: "223n" }, title: "PR", pull_request: {} },
    ]),
  }));

  const text = await githubRead({ repo: "223n/mcp-server", op: "issue_list" });

  assert.match(text, /本物のIssue/);

  assert.doesNotMatch(text, /#2/);
});

test("API の失敗は状態コードを添えて返す", async () => {
  stubFetch(() => ({ status: 404, body: '{"message":"Not Found"}' }));

  await assert.rejects(
    githubRead({ repo: "223n/mcp-server", op: "pr_list" }),
    /failed \(404\).*Not Found/s,
  );
});

test("main や develop を head にした PR の作成を拒む", async () => {
  stubFetch(() => ({ body: "{}" }));

  for (const head of ["main", "develop", "master", "MAIN"]) {
    await assert.rejects(
      githubWrite({ repo: "223n/mcp-server", op: "pr_create", head, base: "main", title: "x" }),
      /Refusing to open a pull request/,
      head,
    );
  }
});

test("base と head が無ければ拒む", async () => {
  await assert.rejects(
    githubWrite({ repo: "223n/mcp-server", op: "pr_create", title: "x" }),
    /`base` and `head` are required/,
  );
});

test("PR を作ると URL を返す", async () => {
  const calls = stubFetch(() => ({
    body: JSON.stringify({ number: 9, html_url: "https://github.com/223n/mcp-server/pull/9" }),
  }));

  const text = await githubWrite({
    repo: "223n/mcp-server",
    op: "pr_create",
    head: "feature/x",
    base: "develop",
    title: "題名",
    body: "本文",
  });

  assert.match(text, /Opened #9/);

  assert.equal(calls[0]!.init.method, "POST");

  assert.deepEqual(JSON.parse(calls[0]!.init.body ?? ""), {
    title: "題名",
    head: "feature/x",
    base: "develop",
    body: "本文",
  });
});

test("知らない op を拒む", async () => {
  // 型の上では通らない op を、わざと実行時に渡して拒まれることを確かめる
  await assert.rejects(
    githubRead({ repo: "223n/mcp-server", op: "repo_delete" as never }),
    /Unknown op/,
  );

  await assert.rejects(
    githubWrite({ repo: "223n/mcp-server", op: "merge" as never }),
    /Unknown op/,
  );
});
