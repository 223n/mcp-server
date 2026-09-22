import { AsyncLocalStorage } from "node:async_hooks";

// 誰の呼び出しかを、リクエストの処理の間だけ持ち回る。
// createMcpHandler のファクトリには Express の req が渡らないため、
// ミドルウェアからここに入れて、ツールの handler から読む
const identityStore = new AsyncLocalStorage();

// 記録してよい引数の鍵。ここに無いものは値を出さない。
// prompt、code、system、context、message、body、content は、中身そのものなので絶対に出さない
const SAFE_KEYS = new Set([
  "op",
  "repo",
  "branch",
  "ref",
  "state",
  "number",
  "limit",
  "depth",
  "path",
  "pattern",
  "max_entries",
  "model",
  "profile",
  "save_output",
  "output_name",
  "line_numbers",
  "staged",
  "stat_only",
  "temperature",
  "max_tokens",
  "language",
]);

// パスの配列はそのまま残す。何をローカルのモデルに渡したかは、監査でいちばん知りたいこと
const PATH_KEYS = new Set(["files", "paths"]);

const MAX_PATHS = 20;

const MAX_VALUE_CHARS = 200;

const MAX_ERROR_CHARS = 300;

function clip(value, limit) {
  const text = String(value);

  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * 引数から、記録してよい部分だけを取り出す。
 * 中身（prompt や content）は、量が多いうえに秘密を含むため、鍵ごと落とす。
 */
export function auditFields(args) {
  const fields = {};

  for (const [key, value] of Object.entries(args ?? {})) {
    if (PATH_KEYS.has(key) && Array.isArray(value)) {
      fields[key] = value.slice(0, MAX_PATHS).map((entry) => clip(entry, MAX_VALUE_CHARS));

      if (value.length > MAX_PATHS) {
        fields[`${key}_total`] = value.length;
      }

      continue;
    }

    // inline_files は名前も呼び出し側が決めるため、件数だけを残す
    if (key === "inline_files" && Array.isArray(value)) {
      fields.inline_files = value.length;

      continue;
    }

    if (!SAFE_KEYS.has(key)) {
      continue;
    }

    fields[key] = typeof value === "string" ? clip(value, MAX_VALUE_CHARS) : value;
  }

  return fields;
}

export function withIdentity(identity, fn) {
  return identityStore.run(identity, fn);
}

// stdio は接続ごとに相手が変わらないため、持ち回らずにプロセス全体の既定として持つ
let defaultIdentity = "-";

export function setDefaultIdentity(identity) {
  defaultIdentity = identity;
}

export function currentIdentity() {
  return identityStore.getStore() ?? defaultIdentity;
}

/**
 * 監査の 1 行を出す。
 *
 * stdout は stdio のとき MCP の通信路なので、必ず stderr に出す。
 * 1 行 1 JSON にして、あとから grep と jq で追えるようにする。
 */
export function audit(event) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),

      identity: currentIdentity(),

      ...event,
    }),
  );
}

/**
 * ツールの呼び出しを、結果まで含めて記録する。
 * 記録に失敗しても呼び出し自体は続ける。
 */
export async function auditedCall(name, args, run) {
  const started = Date.now();

  try {
    const result = await run();

    audit({
      kind: "tool",
      tool: name,
      ok: true,
      ms: Date.now() - started,
      args: auditFields(args),
    });

    return result;
  } catch (error) {
    audit({
      kind: "tool",
      tool: name,
      ok: false,
      ms: Date.now() - started,
      args: auditFields(args),
      error: clip(error?.message ?? error, MAX_ERROR_CHARS),
    });

    throw error;
  }
}
