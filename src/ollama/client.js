import { config } from "../config/config.js";

class OllamaHttpError extends Error {}

const seconds = (ms) => Math.round(ms / 1000);

// 無通信タイムアウト（データが届くたびに延長）と、全体の上限をまとめて扱う
class Deadline {
  constructor(idleMs, maxMs) {
    this.controller = new AbortController();

    this.idleMs = idleMs;

    this.maxTimer = setTimeout(() => this.fire("max"), maxMs);

    this.touch();
  }

  get signal() {
    return this.controller.signal;
  }

  touch() {
    clearTimeout(this.idleTimer);

    this.idleTimer = setTimeout(() => this.fire("idle"), this.idleMs);
  }

  fire(reason) {
    if (!this.reason) {
      this.reason = reason;

      this.controller.abort();
    }
  }

  clear() {
    clearTimeout(this.idleTimer);

    clearTimeout(this.maxTimer);
  }

  describe(path) {
    return this.reason === "idle"
      ? `Ollama ${path} sent nothing for ${seconds(config.ollamaTimeout)} s (OLLAMA_TIMEOUT)`
      : `Ollama ${path} did not finish within ${seconds(config.ollamaMaxDuration)} s (OLLAMA_MAX_DURATION)`;
  }
}

function parseErrorBody(text) {
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}

function explain(error, path, deadline, clientSignal) {
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

  const code = error?.cause?.code ?? error?.code ?? error?.message;

  return new Error(`Cannot reach Ollama at ${config.ollamaUrl} (${code})`);
}

async function open(path, body, signal, deadline) {
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

export async function ollamaRequest(path, body, { signal } = {}) {
  const deadline = new Deadline(config.ollamaTimeout, config.ollamaTimeout);

  try {
    const response = await open(path, body, signal, deadline);

    return await response.json();
  } catch (e) {
    throw explain(e, path, deadline, signal);
  } finally {
    deadline.clear();
  }
}

// /api/chat をストリーミングで呼び出す。
// stream:false だと生成完了までヘッダーが返らず、undici の headersTimeout（300 秒）に
// かかるうえ、進捗も送れないためストリーミングにしている。
export async function ollamaChat({ model, messages, options, signal, onProgress }) {
  const started = Date.now();

  const deadline = new Deadline(config.ollamaTimeout, config.ollamaMaxDuration);

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

    let final;

    const consume = (line) => {
      if (!line.trim()) {
        return;
      }

      const data = JSON.parse(line);

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
