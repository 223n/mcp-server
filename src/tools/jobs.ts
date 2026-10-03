/**
 * 長い生成を、クライアントの打ち切りを越えて続けるためのジョブ。
 *
 * claude.ai のコネクタは約 240 秒、Cloudflare は無通信が約 100 秒で打ち切る。
 * 打ち切られると、途中まで生成した部分も返らない。そこで、受け付けたらすぐに ID を返し、
 * 生成は続けて結果を OUTPUT_DIR に書き、ollama_job で状態と保存先を読めるようにする。
 *
 * MCP の Tasks は 2026-07-28 版で消えたため使わない。ツールの層で持つ。
 * HTTP では 1 リクエストごとにサーバーを作り直すため、一覧はモジュールに置く（limiter と同じ）。
 * stdio には出さない。クライアントが終わるとプロセスごと止まり、ジョブも消えるため。
 */

import { randomUUID } from "node:crypto";

import type { ProgressReporter, ToolResult } from "../types.ts";

import { auditedCall, currentIdentity } from "../audit.ts";

type JobState = "queued" | "running" | "done" | "failed";

type Job = {
  id: string;

  /** 受け付けたときの監査の識別子。ほかの識別子からは読めない */
  owner: string;

  tool: string;
  model: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  chunks: number;

  /** 枠を待っているときの、自分より前に並んでいる数。0 なら次に動く */
  ahead?: number;

  result?: ToolResult;
  error?: string;
};

/** 終わったジョブの記録を残す時間。結果のファイルは OUTPUT_DIR に残り続ける */
export const JOB_TTL_MS = 60 * 60 * 1000;

// 残しておく記録の上限。生成中のものは枠（OLLAMA_MAX_CONCURRENCY + OLLAMA_MAX_QUEUE）で絞られるため、
// ここに当たるのは、終わったジョブが短い間にたまったときだけ
const MAX_JOBS = 100;

const jobs = new Map<string, Job>();

function purge(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

// 上限に当たったら、終わったものを古い順に消して空ける。生成中のものは消さない
function makeRoom(): void {
  if (jobs.size < MAX_JOBS) {
    return;
  }

  const finished = [...jobs.values()]
    .filter((job) => job.finishedAt !== undefined)
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

  for (const job of finished) {
    if (jobs.size < MAX_JOBS) {
      return;
    }

    jobs.delete(job.id);
  }

  if (jobs.size >= MAX_JOBS) {
    throw new Error(`Too many background jobs are in flight (${jobs.size}). Try again in a moment.`);
  }
}

const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/**
 * ジョブを受け付け、生成を始める。受け付けた時点で戻り、生成はその後も続く。
 *
 * run には、クライアントの中断を渡さないこと。クライアントの打ち切りを越えて続けるのが目的のため。
 * 生成は OLLAMA_MAX_DURATION で必ず終わる。
 * 監査には、受け付けの記録とは別に、終わったときの記録（ツール名に ":job" を付けたもの）を残す
 */
export function startJob(
  {
    tool,
    model,
    args,
    run,
  }: {
    tool: string;
    model: string;
    args: unknown;
    run: (onProgress: ProgressReporter) => Promise<ToolResult>;
  },
  now = Date.now(),
): { id: string } {
  purge(now);

  makeRoom();

  const job: Job = {
    id: randomUUID(),

    owner: currentIdentity(),

    tool,

    model,

    state: "queued",

    createdAt: now,

    chunks: 0,
  };

  jobs.set(job.id, job);

  // 枠を待っている間は ahead に前の数が入る（0 なら次に動く）。それ以外の知らせは、生成が始まったことを表す
  const onProgress: ProgressReporter = ({ chunks, ahead }) => {
    if (ahead !== undefined) {
      job.state = "queued";

      job.ahead = ahead;

      return;
    }

    job.state = "running";

    job.startedAt ??= Date.now();

    job.ahead = undefined;

    job.chunks = chunks;
  };

  // 識別子は、受け付けた呼び出しの文脈を引き継ぐ（AsyncLocalStorage）
  auditedCall(`${tool}:job`, args, () => run(onProgress)).then(
    (result) => {
      job.state = "done";

      job.result = result;

      job.finishedAt = Date.now();
    },
    (error: unknown) => {
      job.state = "failed";

      job.error = String(error instanceof Error ? error.message : error).slice(0, 1000);

      job.finishedAt = Date.now();
    },
  );

  return { id: job.id };
}

/** ollama_job の引数。src/tools/index.ts の inputSchema と対で保つこと */
export type JobArgs = {
  id?: string;
};

// 待ち行列の位置を、状態の行に添える形にする。まだ位置を知らないときは何も添えない
function queuePosition(ahead: number | undefined): string {
  if (ahead === undefined) {
    return "";
  }

  return ahead === 0 ? " (next in line)" : ` (${ahead} ahead)`;
}

function statusLine(job: Job, now: number): string {
  switch (job.state) {
    case "queued":
      return `queued${queuePosition(job.ahead)}, ${seconds(now - job.createdAt)} s since accepted`;

    case "running":
      return `running for ${seconds(now - (job.startedAt ?? job.createdAt))} s, ${job.chunks} chunks so far`;

    case "done":
      return `done in ${seconds((job.finishedAt ?? now) - job.createdAt)} s`;

    case "failed":
      return `failed after ${seconds((job.finishedAt ?? now) - job.createdAt)} s`;
  }
}

/**
 * ジョブの状態を返す。id が無ければ、呼んだ識別子のジョブの一覧を返す。
 * ほかの識別子のジョブは、あるかどうかも見せない
 */
export function ollamaJob(args: JobArgs, now = Date.now()): ToolResult {
  purge(now);

  const owner = currentIdentity();

  if (!args.id) {
    const own = [...jobs.values()].filter((job) => job.owner === owner).sort((a, b) => b.createdAt - a.createdAt);

    if (own.length === 0) {
      return "No background jobs for this caller. Finished jobs are kept for 1 hour; their saved files stay under OUTPUT_DIR.";
    }

    return own.map((job) => `${job.id}  ${job.tool}  ${job.model}  ${statusLine(job, now)}`).join("\n");
  }

  const job = jobs.get(args.id);

  if (!job || job.owner !== owner) {
    throw new Error(
      `No background job ${args.id} for this caller. Finished jobs are kept for 1 hour; their saved files stay under OUTPUT_DIR (list them with list_files, read them with read_file).`,
    );
  }

  const header = `Job ${job.id} (${job.tool}, ${job.model}): ${statusLine(job, now)}.`;

  if (job.state === "queued" || job.state === "running") {
    return `${header}\nCheck again in about 30-60 s.`;
  }

  if (job.state === "failed") {
    return `${header}\nError: ${job.error}`;
  }

  const result = job.result ?? "";

  return typeof result === "string" ? `${header}\n${result}` : { ...result, text: `${header}\n${result.text}` };
}

/** ollama_health が出す数。どの識別子のものも数える */
export function jobStats(now = Date.now()): { queued: number; running: number; finished: number } {
  purge(now);

  const all = [...jobs.values()];

  return {
    queued: all.filter((job) => job.state === "queued").length,

    running: all.filter((job) => job.state === "running").length,

    finished: all.filter((job) => job.finishedAt !== undefined).length,
  };
}
