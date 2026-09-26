import type { ChatMessage, ChatResult, ProgressReporter } from "../types.ts";

import { config } from "../config/config.ts";

class OllamaHttpError extends Error {}

/** /api/chat のストリームの 1 行。done の行にだけ統計が入る */
type OllamaChatChunk = {
  error?: string;
  message?: { content?: string };
  done?: boolean;
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
};

/** /api/version の応答 */
export type OllamaVersion = { version?: string };

/** /api/tags の応答。Ollama に入っているモデルの一覧 */
export type OllamaTags = {
  models?: {
    name?: string;
    details?: {
      parameter_size?: string;
      quantization_level?: string;
      context_length?: number;
      family?: string;
    };
  }[];
};

/** /api/ps の応答。いま読み込まれているモデル。context_length は Ollama の版によっては無い */
export type OllamaPs = {
  models?: {
    name?: string;
    size_vram?: number;
    context_length?: number;
    expires_at?: string;
  }[];
};

const seconds = (ms: number): number => Math.round(ms / 1000);

// 状態の確認（/api/version、/api/tags）の上限。生成と違って数秒で返るものなので、
// OLLAMA_TIMEOUT（既定 300 秒）をそのまま使うと、Ollama が固まったときに ollama_health が 300 秒待つ
const STATUS_TIMEOUT_MS = 15000;

/** 状態の確認に使う上限。OLLAMA_TIMEOUT を短くしているときは、そちらに合わせる */
export function statusTimeoutMs(): number {
  return Math.min(config.ollamaTimeout, STATUS_TIMEOUT_MS);
}

/** 打ち切ったときの案内に出す、上限の名前 */
type DeadlineLabels = { idle: string; max: string };

// 無通信タイムアウト（データが届くたびに延長）と、全体の上限をまとめて扱う
class Deadline {
  // erasableSyntaxOnly のため、パラメータープロパティは使わずに宣言と代入を分けて書く
  readonly controller: AbortController;

  readonly idleMs: number;

  readonly maxMs: number;

  readonly labels: DeadlineLabels;

  readonly maxTimer: ReturnType<typeof setTimeout>;

  idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** どちらの上限で打ち切ったか。まだ打ち切っていなければ undefined */
  reason: "idle" | "max" | undefined;

  constructor(idleMs: number, maxMs: number, labels: DeadlineLabels) {
    this.controller = new AbortController();

    this.idleMs = idleMs;

    this.maxMs = maxMs;

    this.labels = labels;

    this.maxTimer = setTimeout(() => this.fire("max"), maxMs);

    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  touch(): void {
    clearTimeout(this.idleTimer);

    this.idleTimer = setTimeout(() => this.fire("idle"), this.idleMs);
  }

  fire(reason: "idle" | "max"): void {
    if (!this.reason) {
      this.reason = reason;

      this.controller.abort();
    }
  }

  clear(): void {
    clearTimeout(this.idleTimer);

    clearTimeout(this.maxTimer);
  }

  // 案内には、この Deadline が実際に使った値を出す。設定の値を読み直すと、
  // 状態の確認のように別の上限で打ち切ったときに、効いていない設定の名前と値を出してしまう
  describe(path: string): string {
    return this.reason === "idle"
      ? `Ollama ${path} sent nothing for ${seconds(this.idleMs)} s (${this.labels.idle})`
      : `Ollama ${path} did not finish within ${seconds(this.maxMs)} s (${this.labels.max})`;
  }
}

function parseErrorBody(text: string): string {
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text;
  }
}

function explain(
  error: unknown,
  path: string,
  deadline: Deadline,
  clientSignal: AbortSignal | undefined,
): Error {
  if (deadline.reason) {
    return new Error(deadline.describe(path));
  }

  if (clientSignal?.aborted) {
    return new Error("Cancelled by the MCP client");
  }

  if (error instanceof OllamaHttpError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return new Error(
      `Ollama ${path} returned a non-JSON response (is OLLAMA_URL correct?): ${error.message}`,
    );
  }

  // fetch の失敗は cause に原因のコードが入る。無ければ自身の code、それも無ければ本文を使う
  const failure = error as { cause?: { code?: string }; code?: string; message?: string } | undefined;

  const code = failure?.cause?.code ?? failure?.code ?? failure?.message;

  return new Error(`Cannot reach Ollama at ${config.ollamaUrl} (${code})`);
}

async function open(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  deadline: Deadline,
): Promise<Response> {
  const response = await fetch(config.ollamaUrl + path, {
    method: body ? "POST" : "GET",

    headers: {
      "Content-Type": "application/json",
    },

    body: body ? JSON.stringify(body) : undefined,

    signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");

    throw new OllamaHttpError(
      `Ollama ${path} returned HTTP ${response.status}: ${parseErrorBody(text)}`,
    );
  }

  return response;
}

// 呼び出し側が応答の形（OllamaVersion / OllamaTags）を指定する
export async function ollamaRequest<T>(
  path: string,
  body?: unknown,
  { signal }: { signal?: AbortSignal } = {},
): Promise<T> {
  // 状態の確認は、無通信と全体を同じ短い上限で見る
  const limit = statusTimeoutMs();

  const label = `OLLAMA_TIMEOUT, at most ${seconds(STATUS_TIMEOUT_MS)} s for status requests`;

  const deadline = new Deadline(limit, limit, { idle: label, max: label });

  try {
    const response = await open(path, body, signal, deadline);

    return (await response.json()) as T;
  } catch (e) {
    throw explain(e, path, deadline, signal);
  } finally {
    deadline.clear();
  }
}

// /api/chat をストリーミングで呼び出す。
// stream:false だと生成完了までヘッダーが返らず、undici の headersTimeout（300 秒）に
// かかるうえ、進捗も送れないためストリーミングにしている。
export async function ollamaChat({
  model,
  messages,
  options,
  signal,
  onProgress,
}: {
  model: string;
  messages: ChatMessage[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
}): Promise<ChatResult> {
  const started = Date.now();

  const deadline = new Deadline(config.ollamaTimeout, config.ollamaMaxDuration, {
    idle: "OLLAMA_TIMEOUT",

    max: "OLLAMA_MAX_DURATION",
  });

  let chunks = 0;

  let content = "";

  // Ollama はヘッダーを最初のトークンと同時に返すので、キュー待ちやプロンプト評価の間も
  // 進捗を送れるよう、リクエストを出す前から通知を始める
  const ticker = onProgress
    ? setInterval(() => onProgress({ chunks, elapsedMs: Date.now() - started }), 10000)
    : undefined;

  try {
    const response = await open(
      "/api/chat",
      { model, messages, stream: true, options },
      signal,
      deadline,
    );

    const decoder = new TextDecoder();

    let buffer = "";

    // Ollama が最後に送る 1 行。生成の統計はここにだけ入る
    let final: OllamaChatChunk | undefined;

    const consume = (line: string): void => {
      if (!line.trim()) {
        return;
      }

      const data = JSON.parse(line) as OllamaChatChunk;

      if (data.error) {
        throw new OllamaHttpError(`Ollama /api/chat error: ${data.error}`);
      }

      if (data.message?.content) {
        content += data.message.content;

        chunks += 1;
      }

      if (data.done) {
        final = data;
      }
    };

    if (!response.body) {
      throw new OllamaHttpError("Ollama /api/chat returned no body");
    }

    for await (const chunk of response.body) {
      deadline.touch();

      buffer += decoder.decode(chunk, { stream: true });

      let newline;

      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));

        buffer = buffer.slice(newline + 1);
      }
    }

    consume(buffer + decoder.decode());

    if (!final) {
      throw new OllamaHttpError("Ollama /api/chat stream ended before completion");
    }

    return {
      content,

      model: final.model ?? model,

      promptTokens: final.prompt_eval_count,

      outputTokens: final.eval_count,

      doneReason: final.done_reason,

      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    // タイムアウトでも、それまでに生成された部分は捨てずに返す
    if (deadline.reason && content) {
      return {
        content,

        model,

        doneReason: "timeout",

        timeoutMessage: deadline.describe("/api/chat"),

        elapsedMs: Date.now() - started,
      };
    }

    throw explain(e, "/api/chat", deadline, signal);
  } finally {
    clearInterval(ticker);

    deadline.clear();
  }
}
