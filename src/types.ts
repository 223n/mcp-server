/**
 * 複数のファイルで共有する型。
 *
 * ここに置くのは「サーバーの中で受け渡す形」だけです。
 * MCP の通信で使う形は SDK の型を使い、ここには写しません。
 * 型しか書かないため、Node はこのファイルを読み込みません（`import type` で参照すること）。
 */

import type {
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";

/**
 * 許可ルート 1 件。
 *
 * ホスト側の表記（`C:\dev`）とコンテナー内のパス（`/work/dev`）を対にして持ちます。
 * `hostPrefix` は突き合わせ用に小文字へ揃えた表記、`hostLabel` は利用者に見せる元の表記です。
 */
export type Root = {
  hostPrefix: string;
  hostLabel: string;
  localPath: string;
};

/**
 * ツールの handler に渡る MCP のリクエストの文脈。
 *
 * SDK の ServerContext をそのまま使います。写すと SDK の更新に付いていけず、
 * 進捗の通知のような「SDK の形に合わせる」箇所で静かにずれるためです。
 */
export type ToolContext = ServerContext;

/** ツールの応答に添える、保存したファイルへの参照 */
export type ResourceLink = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

/**
 * ツールの handler の戻り値。
 *
 * 文字列か、本文と参照の組です。src/server.ts の `toContent` がここを受けて
 * MCP のコンテンツブロックに変えます。
 * `structured` は MCP の structuredContent として、本文と並べて返します。
 * outputSchema は宣言しないため、付けるのは呼び出し側が求めたときだけにします
 */
export type ToolResult =
  | string
  | { text: string; links?: ResourceLink[]; structured?: Record<string, unknown> };

/** ツールの handler。引数は zod の検証を通ったあとの値が渡ります */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx?: ToolContext,
) => ToolResult | Promise<ToolResult>;

/**
 * 1 つのツールの定義。
 *
 * handler の引数は、どのツールも自分の形を持ちます。
 * ここでは共通の形にしておき、src/tools/index.ts が各 handler の形へ変換します。
 * 変換してよいのは、inputSchema による zod の検証を通ったあとの値だからです。
 */
export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: StandardSchemaWithJSON;
  annotations: ToolAnnotations;
  handler: ToolHandler;
};

/** どのツールを登録するかを決める条件 */
export type ToolScope = {
  /** ファイルの読み込みのツールを出すか。HTTP では認証があるときだけ true になります */
  allowFiles: boolean;

  /** 生成結果の書き出しを許すか */
  allowWrites?: boolean;

  /** stdio かどうか。書き込み系のツールは stdio のときだけ登録します */
  local?: boolean;
};

/** 生成の進み具合。進捗の通知に使います */
export type ProgressInfo = {
  chunks: number;
  elapsedMs: number;

  /** 考える過程（thinking）として届いた断片の数。答えの断片は chunks に数える */
  thinkingChunks?: number;

  /** 枠が空くのを待っているときの、自分より前に並んでいる数 */
  queued?: number;

  /** 実行中の生成の数 */
  active?: number;
};

export type ProgressReporter = (info: ProgressInfo) => void;

/** Ollama の /api/chat に渡す 1 通 */
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** ollamaChat の戻り値。タイムアウトで打ち切ったときも、生成できた分をここに入れて返します */
export type ChatResult = {
  content: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  doneReason?: string;

  /** doneReason が "timeout" のときだけ入る、どちらの上限に当たったかの説明 */
  timeoutMessage?: string;

  /** 考える過程として届いた断片の数。答えが空のまま上限に達したときの説明に使う */
  thinkingChunks?: number;

  elapsedMs: number;
};

/**
 * 1 回の生成でローカルのモデルに任せた量。監査の 1 行に載せ、プロセスの中で合計する。
 * 鍵の名前は監査ログの JSON にそのまま出るため、snake_case にしている
 */
export type Usage = {
  /** 実際に使ったモデル。別名（fast、deep）は読み替えたあとの名前 */
  model: string;
  prompt_tokens?: number;
  output_tokens?: number;
  done_reason?: string;

  /** 同時実行の枠を待った時間 */
  queued_ms: number;
};

/**
 * ファイルの読み込みを通さずにサーバーが組み立てた、モデルに渡す 1 件（差分の 1 ファイル分など）。
 * 予算に入らなければ、files と同じく丸ごと落として断り書きに名前を出す
 */
export type ContextSection = {
  /** 落としたときに断り書きへ出す名前 */
  display: string;

  /** 見出しの 1 行 */
  label: string;

  body: string;

  /** フェンスに付ける言語の名前 */
  extension: string;
};

/**
 * モデルに渡した 1 件と、そこで指してよい行の範囲（両端を含む）。
 * 行番号を振って渡したものだけが載る。差分は番号を振った @@ ごとに 1 つの範囲になる
 */
export type ShownPart = {
  name: string;
  ranges: [number, number][];
};

/** ファイルを読んで組み立てた、モデルに渡す文脈 */
export type FileContext = {
  block: string;

  /** 落としたファイルの断り書き。モデルにも利用者にも見せます */
  notes: string[];

  /** 実際に渡したもの。予算で落としたものは載らない */
  shown?: ShownPart[];
};

/** runChat の postProcess の戻り値 */
export type ChatPostProcessed = {
  /** 利用者に返す本文。モデルの出力の代わりに使う */
  content: string;

  /** 本文の前に置く断り書き */
  notes: string[];

  /** MCP の structuredContent として返す値 */
  structured?: Record<string, unknown>;
};

/** runChat の引数。各ツールがツール固有の引数をこの形に直して渡します */
export type ChatRequest = {
  model?: string;
  system?: string;
  prompt: string;
  files?: string[];
  inlineFiles?: InlineFile[];

  /** サーバーが組み立てた差分など。files より先に予算を使う */
  sections?: ContextSection[];

  /** sections の断り書き（秘密のファイルを落とした、差分を切り詰めた）。モデルと利用者の両方に見せる */
  sectionNotes?: string[];

  lineNumbers?: boolean;
  temperature?: number;
  maxTokens?: number;
  save?: boolean;
  outputName?: string;

  /** Ollama の format（JSON Schema）。出力をこの形に絞る */
  format?: Record<string, unknown>;

  /** 生成のあとに出力を読み替える。渡したもの（shown）と照らして確かめるのに使う */
  postProcess?: (content: string, shown: ShownPart[]) => ChatPostProcessed;

  /**
   * 進み具合の知らせ。クライアントへの進捗の通知とは別に受ける（バックグラウンドのジョブが使う）。
   * 枠を得て生成を始めたときにも、queued の無い知らせを 1 度送る
   */
  onProgress?: ProgressReporter;
};

/** 呼び出し側が本文ごと渡してくるファイル。サーバーは読みに行きません */
export type InlineFile = {
  name: string;
  content: string;
};

/** 生成結果を書き出したあとの情報 */
export type SavedOutput = {
  hostPath: string;
  filename: string;
  bytes: number;
  lines: number;
};

/** 起動時の確認で使う、警告の出し先 */
export type Reporter = {
  warn?: (message: string) => void;
};
