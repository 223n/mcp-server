/**
 * ollama_review_code の structured。指摘を JSON で受け、渡していないファイルや行を指すものを落とす。
 *
 * 小さいモデルは、存在しない行番号や、渡していないファイルを指すことがある。
 * サーバーは渡したものと行の範囲を知っているため、明らかな誤りはここで機械的に落とす。
 * 落としたことは件数と理由を本文に書き、黙って消さない。
 */

import type { ChatPostProcessed, ShownPart } from "../types.ts";

const SEVERITIES = ["high", "medium", "low"] as const;

type Severity = (typeof SEVERITIES)[number];

/** 検証を通った 1 件。structuredContent の findings に並ぶ */
export type Finding = {
  file: string;
  line: number;
  severity: Severity;

  /** 問題の行の写し。モデルにその行を読み直させるために書かせる */
  evidence: string;

  /** 問題が起きる入力や状態。書けない候補は捨てるようプロンプトで頼んでいる */
  scenario: string;

  problem: string;
  fix: string;
};

/** 落とした 1 件。structuredContent の dropped に並ぶ */
export type DroppedFinding = {
  file: string;
  line: number | null;
  reason: "unknown file" | "line out of range" | "malformed";
};

/** Ollama の format に渡す形。ここから外れた出力は、形の上で受け付けない */
export const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "object",

  properties: {
    findings: {
      type: "array",

      items: {
        type: "object",

        properties: {
          file: { type: "string" },

          line: { type: "integer" },

          severity: { type: "string", enum: [...SEVERITIES] },

          evidence: { type: "string" },

          scenario: { type: "string" },

          problem: { type: "string" },

          fix: { type: "string" },
        },

        required: ["file", "line", "severity", "evidence", "scenario", "problem", "fix"],
      },
    },
  },

  required: ["findings"],
};

// モデルが並べすぎたときに読む上限。プロンプトでは 5 件までと頼んでいる
const MAX_FINDINGS = 20;

const MAX_TEXT_CHARS = 2000;

const SEVERITY_LABEL: Record<Severity, string> = { high: "高", medium: "中", low: "低" };

// 形を強いても日本語で返すことがあるため、両方を受ける
const SEVERITY_ALIASES: Record<string, Severity> = {
  high: "high",
  medium: "medium",
  low: "low",
  高: "high",
  中: "medium",
  低: "low",
};

// 突き合わせ用に、区切りと大文字小文字を揃える。Windows のパスは大文字小文字を区別しないため
function normalize(name: string): string {
  return name.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// 名前 1 つで当てる。完全に一致しなければ、末尾が一致するものが 1 つだけのときに限って当てる（"Main.php" と書かれた場合など）
function matchName(wanted: string, shown: ShownPart[]): ShownPart | undefined {
  if (wanted === "") {
    return undefined;
  }

  const exact = shown.find((part) => normalize(part.name) === wanted);

  if (exact) {
    return exact;
  }

  const suffix = shown.filter((part) => normalize(part.name).endsWith(`/${wanted}`));

  return suffix.length === 1 ? suffix[0] : undefined;
}

// 指摘の file を、渡したものの名前に当てる。
// 見出しの添え書き（"(12 lines)"、"(renamed from …)"）や行範囲（"#L10-200"）まで写してくることがあるため、
// 当たらなければそれらを外してもう一度当てる
function matchPart(file: string, shown: ShownPart[]): ShownPart | undefined {
  const wanted = normalize(file);

  return (
    matchName(wanted, shown) ??
    matchName(wanted.replace(/\s*\([^)]*\)\s*$/, "").replace(/#l\d+(?:-l?\d*)?$/, ""), shown)
  );
}

function clip(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}…`;
}

// モデルがコードブロックで包んで返すことがあるため、外してから読む
function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");

  return JSON.parse(trimmed);
}

type Candidate = { finding?: Omit<Finding, "file"> & { file: string }; dropped?: DroppedFinding };

// 1 件の形を確かめる。外から来た値なので、型を決めてかからない
function readItem(item: unknown): Candidate {
  if (typeof item !== "object" || item === null) {
    return { dropped: { file: "", line: null, reason: "malformed" } };
  }

  const record = item as Record<string, unknown>;

  const file = typeof record.file === "string" ? record.file : "";

  const line = typeof record.line === "number" && Number.isInteger(record.line) ? record.line : null;

  const severity = typeof record.severity === "string" ? SEVERITY_ALIASES[record.severity.trim().toLowerCase()] : undefined;

  const problem = typeof record.problem === "string" ? record.problem.trim() : "";

  if (line === null || severity === undefined || problem === "") {
    return { dropped: { file, line, reason: "malformed" } };
  }

  const text = (value: unknown): string => (typeof value === "string" ? clip(value.trim()) : "");

  return {
    finding: {
      file,

      line,

      severity,

      // 写しは行頭の字下げも含めて受け取る。読み手が元の行と見比べられるようにする
      evidence: typeof record.evidence === "string" ? clip(record.evidence) : "",

      scenario: text(record.scenario),

      problem: clip(problem),

      fix: text(record.fix),
    },
  };
}

function renderFinding(finding: Finding): string {
  const scenario = finding.scenario ? `（起きる条件: ${finding.scenario}）` : "";

  const fix = finding.fix ? ` → ${finding.fix}` : "";

  return `- [重大度: ${SEVERITY_LABEL[finding.severity]}] ${finding.file}:${finding.line}: ${finding.problem}${scenario}${fix}`;
}

function describeDropped(dropped: DroppedFinding): string {
  const place = dropped.line === null ? dropped.file || "(no file)" : `${dropped.file || "(no file)"}:${dropped.line}`;

  return `${place} (${dropped.reason})`;
}

/**
 * モデルの出力（JSON）を読み、渡したもの（shown）と照らして確かめる。
 * JSON として読めなければ、出力をそのまま返して断り書きを付ける。構造化した値は付けない
 */
export function checkFindings(content: string, shown: ShownPart[]): ChatPostProcessed {
  let parsed: unknown;

  try {
    parsed = parseJson(content);
  } catch {
    return {
      content,

      notes: ["WARNING: the model did not return valid JSON for `structured`, so the findings were not checked. The raw output follows."],
    };
  }

  const items = (parsed as { findings?: unknown } | null)?.findings;

  if (!Array.isArray(items)) {
    return {
      content,

      notes: ["WARNING: the model's JSON has no `findings` array, so the findings were not checked. The raw output follows."],
    };
  }

  const findings: Finding[] = [];

  const dropped: DroppedFinding[] = [];

  for (const item of items.slice(0, MAX_FINDINGS)) {
    const candidate = readItem(item);

    if (candidate.dropped || !candidate.finding) {
      dropped.push(candidate.dropped ?? { file: "", line: null, reason: "malformed" });

      continue;
    }

    const { finding } = candidate;

    const part = matchPart(finding.file, shown);

    if (!part) {
      dropped.push({ file: finding.file, line: finding.line, reason: "unknown file" });

      continue;
    }

    if (!part.ranges.some(([from, to]) => finding.line >= from && finding.line <= to)) {
      dropped.push({ file: part.name, line: finding.line, reason: "line out of range" });

      continue;
    }

    // 名前は渡したものの表記に揃える。呼び出し側がそのまま Read などに使えるようにする
    findings.push({ ...finding, file: part.name });
  }

  const notes =
    dropped.length > 0
      ? [
          `NOTE: dropped ${dropped.length} finding(s) that pointed at files or lines not passed to the model: ${dropped
            .slice(0, 10)
            .map(describeDropped)
            .join(", ")}${dropped.length > 10 ? ", …" : ""}`,
        ]
      : [];

  if (items.length > MAX_FINDINGS) {
    notes.push(`NOTE: the model returned ${items.length} findings; only the first ${MAX_FINDINGS} were checked.`);
  }

  return {
    content: findings.length > 0 ? findings.map(renderFinding).join("\n") : "指摘なし",

    notes,

    structured: { findings, dropped },
  };
}
