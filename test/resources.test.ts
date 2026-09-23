import assert from "node:assert/strict";

import { writeFileSync } from "node:fs";

import path from "node:path";

import { after, test } from "node:test";

import { Client } from "@modelcontextprotocol/client";

import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createFileTree, removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

// 手元の .env を読ませないため、設定を読み込む前に作業ディレクトリを移す
process.chdir(WORK_DIR);

after(removeCreatedTrees);

const root = createFileTree();

process.env.FILE_ROOTS = root;

const { createServer } = await import("../src/server.ts");

const { toFileUri } = await import("../src/tools/resources.ts");

const at = (...parts: string[]): string => path.join(root, ...parts);

// リソースを読める状態のクライアントを 1 つ作る
async function connect({ allowFiles = true } = {}) {
  const server = createServer({ allowFiles });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode: "legacy" } });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,

    close: async () => {
      await client.close();

      await server.close();
    },
  };
}

// contents は text か blob のどちらかを持つ。この試験はテキストしか読まない
const readText = async (client: Client, uri: string): Promise<string> =>
  (await client.readResource({ uri })).contents
    .map((c) => ("text" in c ? c.text : ""))
    .join("\n");

test("ファイルを扱えるときは resources の能力を宣言する", async () => {
  const { client, close } = await connect();

  assert.ok(client.getServerCapabilities()?.resources, "resources capability is missing");

  await close();
});

test("ファイルを扱えないときは resources を出さない", async () => {
  const { client, close } = await connect({ allowFiles: false });

  assert.equal(client.getServerCapabilities()?.resources, undefined);

  await assert.rejects(client.readResource({ uri: toFileUri(at("app", "src", "Main.php")) }));

  await close();
});

test("一覧は許可ルートだけを返す", async () => {
  const { client, close } = await connect();

  const { resources } = await client.listResources();

  assert.equal(resources.length, 1);

  assert.equal(resources[0]!.name, root);

  assert.equal(resources[0]!.uri, toFileUri(root));

  await close();
});

test("ファイルの URI は中身を返す", async () => {
  const { client, close } = await connect();

  const text = await readText(client, toFileUri(at("app", "src", "Main.php")));

  assert.match(text, /### File: /);

  assert.match(text, /echo 'hello';/);

  await close();
});

test("ディレクトリの URI は一覧を返す", async () => {
  const { client, close } = await connect();

  const text = await readText(client, toFileUri(at("app")));

  assert.match(text, /README\.md/);

  assert.doesNotMatch(text, /\.npmrc/);

  await close();
});

test("URI に #L を付けると行範囲を返す", async () => {
  writeFileSync(at("lines.txt"), Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n"));

  const { client, close } = await connect();

  const text = await readText(client, `${toFileUri(at("lines.txt"))}#L5-7`);

  assert.match(text, /\(lines 5-7 of 30\)/);

  assert.match(text, /line5/);

  assert.doesNotMatch(text, /line8/);

  await close();
});

test("空白と日本語を含む名前でも往復できる", async () => {
  writeFileSync(at("app", "メモ 1.md"), "# メモ\n");

  const { client, close } = await connect();

  const uri = toFileUri(at("app", "メモ 1.md"));

  assert.match(uri, /%20/);

  assert.match(await readText(client, uri), /# メモ/);

  await close();
});

// [名前, 読むパスを作る関数, 期待するエラー]
const rejectCases: [string, () => string, RegExp][] = [
  ["秘密のファイル", () => at("app", ".env"), /may contain secrets/],
  ["秘密のディレクトリの配下", () => at("app", ".git", "config"), /may contain secrets/],
  [".ssh", () => at("app", ".ssh", "config"), /may contain secrets/],
  ["許可ルートの外", () => path.join(root, "..", "outside.txt"), /outside the allowed roots/],
  ["存在しないファイル", () => at("app", "missing.txt"), /File not found/],
  ["バイナリ", () => at("binary.bin"), /Binary file/],
];

for (const [name, target, expected] of rejectCases) {
  test(`resources/read でも拒む: ${name}`, async () => {
    const { client, close } = await connect();

    await assert.rejects(client.readResource({ uri: toFileUri(target()) }), (error: unknown) => {
      assert.match((error as Error).message, expected);

      return true;
    });

    await close();
  });
}

test("符号化した .. でも外へ出られない", async () => {
  const { client, close } = await connect();

  const base = toFileUri(at("app"));

  for (const uri of [
    `${base}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`,
    `${base}/%252e%252e/%252e%252e/%252e%252e/etc/passwd`,
    `${base}/..%2f..%2f..%2fetc%2fpasswd`,
  ]) {
    await assert.rejects(client.readResource({ uri }));
  }

  await close();
});

test("知らないスキームは拒む", async () => {
  const { client, close } = await connect();

  await assert.rejects(client.readResource({ uri: "ollama:///x" }));

  await close();
});
