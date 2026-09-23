import type { McpServer, ServerContext, Variables } from "@modelcontextprotocol/server";

import { ResourceTemplate } from "@modelcontextprotocol/server";

import { audit } from "../audit.ts";

import { readForResource, readRoots } from "./files.ts";

// ホスト側の表記（C:\dev\app\x.php）を file:/// の URI にする。
// SDK の UriTemplate は match のときに復号しないため、こちらも段ごとに符号化し、
// 読み込み側で 1 度だけ復号する。二重に符号化・復号しないこと
export function toFileUri(hostPath: string): string {
  // "file:///" が区切りを 1 つ持っているため、コンテナー内の絶対パス（/work/dev/...）の
  // 先頭の "/" は落とす。落とさないと file:////work/... になり、読み込み側で戻せない
  const segments = hostPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent);

  return `file:///${segments.join("/")}`;
}

// URI のテンプレートが取り出した値を、ホスト側の表記に戻す。復号はここだけで 1 度行う
export function fromUriPath(raw: unknown): string {
  const decoded = decodeURIComponent(String(raw));

  if (decoded.includes(String.fromCharCode(0))) {
    throw new Error("Invalid resource URI");
  }

  // コンテナー内の絶対パス（/work/dev/...）はテンプレートが先頭の "/" を落とすため、戻す
  return /^[A-Za-z]:/.test(decoded) ? decoded : `/${decoded}`;
}

/**
 * 許可ルートの中のファイルを MCP のリソースとして公開する。
 *
 * ツールと同じ条件（allowFiles）でだけ呼ぶこと。
 * resources/read にはツール名が無く、mcp__ollama__* の許可の対象にならないため、
 * ここを緩めると、ファイルのツールを拒否した利用者にも読み込みの経路が残る。
 */
export function registerFileResources(server: McpServer): void {
  server.registerResource(
    "allowed-roots",

    new ResourceTemplate("file:///{+path}", {
      // 全ファイルは列挙しない。SDK は cursor を読まずページングもしないため、
      // 一覧は許可ルートだけに絞り、その先は list_files でたどってもらう
      list: () => ({
        resources: readRoots().map((root) => ({
          uri: toFileUri(root.hostLabel),

          name: root.hostLabel,

          description: "Allowed root; read it for a listing, or read a file below it.",

          mimeType: "text/plain",
        })),
      }),
    }),

    {
      title: "Files under the allowed roots",

      description:
        "Read a file, or a directory listing, from the machine that runs Ollama. Same restrictions as the file tools: allowed roots only, secret files refused, symlinks not followed. Append `#L10-200` to a file URI for a line range.",

      mimeType: "text/plain",
    },

    async (uri: URL, variables: Variables, ctx: ServerContext) => {
      // resources/read にはツール名が無く、ツールの監査に載らない。
      // 読み取りの経路としてはツールと同じ重さなので、ここで別に記録する
      const input = fromUriPath(variables.path);

      const started = Date.now();

      try {
        const text = await readForResource(input, { signal: ctx?.mcpReq?.signal });

        audit({ kind: "resource", ok: true, ms: Date.now() - started, path: input });

        return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
      } catch (error) {
        audit({
          kind: "resource",
          ok: false,
          ms: Date.now() - started,
          path: input,
          error: String(error instanceof Error ? error.message : error).slice(0, 300),
        });

        throw error;
      }
    },
  );
}
