import type { ToolContext } from "../types.ts";

import { config } from "../config/config.ts";

/**
 * GitHub の API から返る値のうち、このサーバーが読む部分だけ。
 *
 * 相手から来る値なので、どれも「あるかもしれない」形にしておきます。
 * 全部を書き写さないのは、使っていない項目の形が変わっても困らないようにするためです。
 */
type GitHubUser = { login?: string };

type GitHubRef = { ref?: string; sha?: string };

type GitHubPull = {
  number?: number;
  title?: string;
  state?: string;
  merged?: boolean;
  mergeable_state?: string;
  user?: GitHubUser;
  head?: GitHubRef;
  base?: GitHubRef;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  body?: string;
  html_url?: string;
};

type GitHubIssue = {
  number?: number;
  title?: string;
  state?: string;
  user?: GitHubUser;
  body?: string;
  pull_request?: unknown;
};

type GitHubComment = { user?: GitHubUser; created_at?: string; body?: string; html_url?: string };

type GitHubCheckRuns = { check_runs?: { name?: string; status?: string; conclusion?: string }[] };

/** github_read の引数。src/tools/index.ts の inputSchema と対で保つこと */
export type GitHubReadArgs = {
  repo: string;
  op: "pr_list" | "pr_view" | "pr_diff" | "pr_comments" | "pr_checks" | "issue_list" | "issue_view";
  number?: number;
  state?: "open" | "closed" | "all";
  limit?: number;
};

/** github_write の引数 */
export type GitHubWriteArgs = {
  repo: string;
  op: "pr_create" | "comment";
  title?: string;
  head?: string;
  base?: string;
  number?: number;
  body?: string;
};

type ApiOptions = {
  method?: string;
  body?: unknown;

  /** これを渡すと、JSON にせず本文をそのまま返す（pr_diff が使う） */
  accept?: string;

  signal?: AbortSignal;
};

const API = "https://api.github.com";

const MAX_BODY_CHARS = 40000;

// git.ts と同じ形だけを通す。パスに使う文字が混ざらないようにする
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const REPO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export function githubReady(): boolean {
  return Boolean(config.githubToken);
}

function splitRepo(input: unknown): { owner: string; repo: string } {
  const [owner = "", repo = "", ...rest] = String(input).trim().split("/");

  if (rest.length > 0 || !OWNER.test(owner) || !REPO.test(repo)) {
    throw new Error(`\`repo\` must be "owner/repo", got: ${input}`);
  }

  if (!config.gitAllowedOwners.includes(owner.toLowerCase())) {
    throw new Error(
      `Owner "${owner}" is not in GIT_ALLOWED_OWNERS (${config.gitAllowedOwners.join(", ") || "empty"})`,
    );
  }

  return { owner, repo };
}

function trim(text: unknown, limit = MAX_BODY_CHARS): string {
  const value = String(text ?? "");

  return value.length <= limit ? value : `${value.slice(0, limit)}\n... [truncated]`;
}

/**
 * GitHub の API を呼ぶ。
 *
 * gh CLI は入れない。必要なのは数本のエンドポイントだけで、
 * gh を入れると gh api / gh alias / gh extension という別の実行経路が増えるため。
 */
async function api<T>(
  path: string,
  { method = "GET", body, accept, signal }: ApiOptions = {},
): Promise<T> {
  if (!config.githubToken) {
    throw new Error("GITHUB_MCP_TOKEN is not set on this server");
  }

  const response = await fetch(`${API}${path}`, {
    method,

    headers: {
      Accept: accept ?? "application/vnd.github+json",

      Authorization: `Bearer ${config.githubToken}`,

      "X-GitHub-Api-Version": "2022-11-28",

      "User-Agent": "ollama-mcp",

      ...(body ? { "Content-Type": "application/json" } : {}),
    },

    body: body ? JSON.stringify(body) : undefined,

    signal,
  });

  const text = await response.text();

  if (!response.ok) {
    // 本文にトークンは載らないが、長いHTMLが返ることがあるので切り詰める
    throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${trim(text, 500)}`);
  }

  return (accept ? text : JSON.parse(text || "null")) as T;
}

const line = (parts: (string | number | undefined)[]): string =>
  parts.filter(Boolean).join("  ");

export async function githubRead(args: GitHubReadArgs, ctx?: ToolContext): Promise<string> {
  const { owner, repo } = splitRepo(args.repo);

  const signal = ctx?.mcpReq?.signal;

  const limit = Math.min(args.limit ?? 20, 100);

  switch (args.op) {
    case "pr_list": {
      const items = await api<GitHubPull[]>(
        `/repos/${owner}/${repo}/pulls?state=${args.state ?? "open"}&per_page=${limit}`,
        { signal },
      );

      return (
        items
          .map((pr) =>
            line([`#${pr.number}`, pr.state, pr.user?.login, `${pr.head?.ref} -> ${pr.base?.ref}`, pr.title]),
          )
          .join("\n") || "No pull requests matched."
      );
    }

    case "pr_view": {
      const pr = await api<GitHubPull>(`/repos/${owner}/${repo}/pulls/${number(args.number)}`, {
        signal,
      });

      return [
        `#${pr.number} ${pr.title}`,
        line([pr.state, pr.merged ? "merged" : pr.mergeable_state, `${pr.head?.ref} -> ${pr.base?.ref}`]),
        `by ${pr.user?.login}  +${pr.additions}/-${pr.deletions} in ${pr.changed_files} files`,
        "",
        trim(pr.body) || "(no description)",
      ].join("\n");
    }

    case "pr_diff":
      return trim(
        await api<string>(`/repos/${owner}/${repo}/pulls/${number(args.number)}`, {
          accept: "application/vnd.github.diff",

          signal,
        }),
      );

    case "pr_comments": {
      const items = await api<GitHubComment[]>(
        `/repos/${owner}/${repo}/issues/${number(args.number)}/comments?per_page=${limit}`,
        { signal },
      );

      return (
        items.map((c) => `--- ${c.user?.login} (${c.created_at})\n${trim(c.body, 4000)}`).join("\n\n") ||
        "No comments."
      );
    }

    case "pr_checks": {
      const pr = await api<GitHubPull>(`/repos/${owner}/${repo}/pulls/${number(args.number)}`, {
        signal,
      });

      if (!pr.head?.sha) {
        throw new Error(`GitHub did not return a head commit for #${number(args.number)}`);
      }

      const runs = await api<GitHubCheckRuns>(
        `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
        { signal },
      );

      return (
        (runs.check_runs ?? [])
          .map((run) => line([run.conclusion ?? run.status, run.name]))
          .join("\n") || "No check runs on the head commit."
      );
    }

    case "issue_list": {
      const items = await api<GitHubIssue[]>(
        `/repos/${owner}/${repo}/issues?state=${args.state ?? "open"}&per_page=${limit}`,
        { signal },
      );

      return (
        items
          .filter((issue) => !issue.pull_request)
          .map((issue) => line([`#${issue.number}`, issue.state, issue.user?.login, issue.title]))
          .join("\n") || "No issues matched."
      );
    }

    case "issue_view": {
      const issue = await api<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number(args.number)}`, {
        signal,
      });

      return [
        `#${issue.number} ${issue.title}`,
        line([issue.state, `by ${issue.user?.login}`]),
        "",
        trim(issue.body) || "(no body)",
      ].join("\n");
    }

    default:
      throw new Error(`Unknown op: ${args.op}`);
  }
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`\`number\` must be a positive integer, got: ${value}`);
  }

  return value;
}

export async function githubWrite(args: GitHubWriteArgs, ctx?: ToolContext): Promise<string> {
  const { owner, repo } = splitRepo(args.repo);

  const signal = ctx?.mcpReq?.signal;

  switch (args.op) {
    case "pr_create": {
      const base = String(args.base ?? "").trim();

      const head = String(args.head ?? "").trim();

      if (!base || !head) {
        throw new Error("`base` and `head` are required for op \"pr_create\"");
      }

      // CLAUDE.md: main と develop を head にした Pull Request は、
      // マージでそのブランチごと消える恐れがある
      if (/^(main|master|develop)$/i.test(head)) {
        throw new Error(
          `Refusing to open a pull request with "${head}" as the head branch; it would be deleted on merge.`,
        );
      }

      const pr = await api<GitHubPull>(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",

        body: { title: String(args.title ?? "").trim(), head, base, body: String(args.body ?? "") },

        signal,
      });

      return `Opened #${pr.number}: ${pr.html_url}`;
    }

    case "comment": {
      const comment = await api<GitHubComment>(
        `/repos/${owner}/${repo}/issues/${number(args.number)}/comments`,
        { method: "POST", body: { body: String(args.body ?? "") }, signal },
      );

      return `Commented on #${args.number}: ${comment.html_url}`;
    }

    default:
      throw new Error(`Unknown op: ${args.op}`);
  }
}
