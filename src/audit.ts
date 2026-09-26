import { AsyncLocalStorage } from "node:async_hooks";

import { appendFileSync, closeSync, openSync, readdirSync, realpathSync, rmSync } from "node:fs";

import path from "node:path";

import { config } from "./config/config.ts";

import type { Usage } from "./types.ts";

// 誰の呼び出しかを、リクエストの処理の間だけ持ち回る。
// createMcpHandler のファクトリには Express の req が渡らないため、
// ミドルウェアからここに入れて、ツールの handler から読む
const identityStore = new AsyncLocalStorage<string>();

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

function clip(value: unknown, limit: number): string {
  const text = String(value);

  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 監査に残す 1 行。tool と resource のどちらの記録もこの形にする */
export type AuditEvent = {
  kind: "tool" | "resource";
  ok: boolean;
  ms: number;
  tool?: string;
  path?: string;
  args?: AuditFields;
  usage?: Usage;
  error?: string;
};

// ツールの呼び出しの間だけ、ローカルのモデルに任せた量を持ち回る。
// auditedCall はツールの戻り値（文字列）しか見ないため、runChat からここに入れてもらう
const usageStore = new AsyncLocalStorage<{ usage?: Usage }>();

/** プロセスが動き始めてからの合計。1 つのモデルか 1 人の識別子ごとの行 */
export type UsageTotal = { calls: number; prompt_tokens: number; output_tokens: number };

const totals = { models: new Map<string, UsageTotal>(), identities: new Map<string, UsageTotal>() };

function addTo(map: Map<string, UsageTotal>, key: string, usage: Usage): void {
  const total = map.get(key) ?? { calls: 0, prompt_tokens: 0, output_tokens: 0 };

  total.calls += 1;

  total.prompt_tokens += usage.prompt_tokens ?? 0;

  total.output_tokens += usage.output_tokens ?? 0;

  map.set(key, total);
}

/**
 * ローカルのモデルに任せた量を記録する。runChat が生成のあとに呼ぶ。
 * 呼び出しの監査の 1 行に載せ、モデルごとと識別子ごとの合計に足す
 */
export function recordUsage(usage: Usage): void {
  const store = usageStore.getStore();

  if (store) {
    store.usage = usage;
  }

  addTo(totals.models, usage.model, usage);

  addTo(totals.identities, currentIdentity(), usage);
}

/** プロセスが動き始めてからの合計。ollama_health が出す */
export function usageTotals(): { models: Map<string, UsageTotal>; identities: Map<string, UsageTotal> } {
  return totals;
}

/**
 * 監査に残してよい引数だけを抜き出したもの。
 *
 * 値の型は絞らない。SAFE_KEYS の値は今のところ文字列・数値・真偽値だけだが、
 * 想定外の形が来たときに黙って落とすより、そのまま記録したほうが監査の役に立つ。
 */
export type AuditFields = Record<string, unknown>;

/**
 * 引数から、記録してよい部分だけを取り出す。
 * 中身（prompt や content）は、量が多いうえに秘密を含むため、鍵ごと落とす。
 */
export function auditFields(args: unknown): AuditFields {
  const fields: AuditFields = {};

  for (const [key, value] of Object.entries((args ?? {}) as Record<string, unknown>)) {
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

export function withIdentity<T>(identity: string, fn: () => T): T {
  return identityStore.run(identity, fn);
}

// stdio は接続ごとに相手が変わらないため、持ち回らずにプロセス全体の既定として持つ
let defaultIdentity = "-";

export function setDefaultIdentity(identity: string): void {
  defaultIdentity = identity;
}

export function currentIdentity(): string {
  return identityStore.getStore() ?? defaultIdentity;
}

// 監査ログのファイルの書き出し先。initAuditLog が確かめたときだけ入る
let logDir: string | null = null;

// 書き出しに失敗したことを、失敗が続く間は 1 度だけ知らせる
let writeFailing = false;

const LOG_FILE = /^audit-(\d{8})\.jsonl$/;

// UTC の日付で 1 日 1 ファイルにする。大きさで世代を回すと、HTTP と stdio の
// 複数のプロセスの間で名前の付け替えがぶつかるため
function logFileFor(date: Date): string {
  return `audit-${date.toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * AUDIT_LOG_DIR が使えるかを起動時に確かめる。使えなければ標準エラーにだけ出す。
 *
 * FILE_ROOTS の中は拒む。list_files や files から、誰が何を読んだかの記録を読めてしまうため
 */
export function initAuditLog({ warn = console.error }: { warn?: (message: string) => void } = {}): boolean {
  logDir = null;

  const dir = config.auditLogDir;

  if (!dir) {
    return false;
  }

  if (!path.posix.isAbsolute(dir)) {
    warn(`[audit] AUDIT_LOG_DIR must be an absolute path in the container, file logging is disabled: ${dir}`);

    return false;
  }

  let real: string;

  try {
    real = realpathSync(dir).replace(/\\/g, "/");
  } catch {
    warn(`[audit] AUDIT_LOG_DIR does not exist, file logging is disabled: ${dir}`);

    return false;
  }

  const readable = config.fileRoots.find((root) => isInside(real, root.localPath));

  if (readable) {
    warn(
      `[audit] AUDIT_LOG_DIR is inside FILE_ROOTS (${readable.hostLabel}), so the file tools could read it. File logging is disabled. Use a path outside FILE_ROOTS, such as a Docker volume.`,
    );

    return false;
  }

  // 実際に書けるかを、一時ファイルを作って確かめる
  const probe = `${real}/.ollama-mcp-audit-probe`;

  try {
    closeSync(openSync(probe, "wx"));

    rmSync(probe, { force: true });
  } catch (error) {
    warn(`[audit] AUDIT_LOG_DIR is not writable, file logging is disabled: ${error instanceof Error ? error.message : error}`);

    return false;
  }

  logDir = real;

  return true;
}

/**
 * 残す日数より古い監査ログのファイルを消す。HTTP のプロセスだけが呼ぶ。
 * 消すのは audit-YYYYMMDD.jsonl の形の名前だけで、ほかのファイルには触れない
 */
export function pruneAuditLogs(now: Date = new Date()): string[] {
  if (!logDir) {
    return [];
  }

  const cutoff = new Date(now.getTime() - config.auditRetentionDays * 24 * 60 * 60 * 1000);

  const oldest = logFileFor(cutoff);

  const removed: string[] = [];

  for (const name of readdirSync(logDir)) {
    if (LOG_FILE.test(name) && name < oldest) {
      rmSync(`${logDir}/${name}`, { force: true });

      removed.push(name);
    }
  }

  return removed;
}

/**
 * 監査の 1 行を出す。
 *
 * stdout は stdio のとき MCP の通信路なので、必ず stderr に出す。
 * 1 行 1 JSON にして、あとから grep と jq で追えるようにする。
 * AUDIT_LOG_DIR を設定したときは、ファイルにも追記する。HTTP と stdio の両方のプロセスが
 * 同じファイルに書くため、1 行を 1 回の追記（O_APPEND）で書く
 */
export function audit(event: AuditEvent): void {
  const now = new Date();

  const line = JSON.stringify({
    ts: now.toISOString(),

    identity: currentIdentity(),

    ...event,
  });

  console.error(line);

  if (!logDir) {
    return;
  }

  try {
    appendFileSync(`${logDir}/${logFileFor(now)}`, `${line}\n`, { flag: "a", mode: 0o640 });

    writeFailing = false;
  } catch (error) {
    // 記録に失敗しても呼び出し自体は続ける。失敗が続く間は 1 度だけ知らせる
    if (!writeFailing) {
      writeFailing = true;

      console.error(`[audit] could not write the audit log file: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/**
 * ツールの呼び出しを、結果まで含めて記録する。
 * 記録に失敗しても呼び出し自体は続ける。
 */
export async function auditedCall<T>(name: string, args: unknown, run: () => Promise<T> | T): Promise<T> {
  const started = Date.now();

  const store: { usage?: Usage } = {};

  try {
    const result = await usageStore.run(store, run);

    audit({
      kind: "tool",
      tool: name,
      ok: true,
      ms: Date.now() - started,
      args: auditFields(args),
      ...(store.usage ? { usage: store.usage } : {}),
    });

    return result;
  } catch (error) {
    audit({
      kind: "tool",
      tool: name,
      ok: false,
      ms: Date.now() - started,
      args: auditFields(args),
      ...(store.usage ? { usage: store.usage } : {}),
      error: clip(error instanceof Error ? error.message : error, MAX_ERROR_CHARS),
    });

    throw error;
  }
}
