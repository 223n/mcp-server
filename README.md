# mcp-server

ローカルのOllamaをMCPサーバーとして公開し、Claudeから作業を任せられるようにするNode.jsのサーバーです。
公式のMCP TypeScript SDK v2で作っています。

入口は次の2つです。
どちらもMCPの2026-07-28版（`server/discover`）と2025年版（`initialize`）の両方に応答します。

| 入口                                               | 用途                                                              | ファイルの読み込み                                          | 出力の保存                                                   |
|----------------------------------------------------|-------------------------------------------------------------------|-------------------------------------------------------------|--------------------------------------------------------------|
| stdio（`docker exec -i ollama-mcp node stdio.ts`） | 同じPCのClaude CodeとClaude Desktopから使います。こちらを勧めます | 使えます（`FILE_ROOTS`の配下だけ）                          | `OUTPUT_DIR`を設定したときだけ使えます                       |
| HTTP（`POST /mcp`、ポート3000）                    | Cloudflare Tunnelを通して、claude.aiなどから使います              | `HTTP_ALLOW_FILES=true`と認証を両方設定したときだけ使えます | `HTTP_ALLOW_WRITES=true`と認証と`OUTPUT_DIR`が要ります       |

## 構成

```text
[ローカル]
Claude Code / Claude Desktop ──stdio──> docker exec ollama-mcp node stdio.ts ──> Ollama（ホストの11434番）

[リモート]
claude.ai ──HTTPS──> Cloudflare Access ──> Cloudflare Tunnel ──> 127.0.0.1:3000/mcp ──> Ollama
```

claude.aiとClaude Desktopのカスタムコネクタは、このPCではなくAnthropicのクラウドから接続します。
同じPCで使うだけなら、ローカル（stdio）の接続が確実です。
トンネルとAccessは要りません。

## MCPのツール

| ツール                 | 内容                                                                                                                      | 既定のモデル    |
|------------------------|---------------------------------------------------------------------------------------------------------------------------|-----------------|
| `ollama_chat`          | 下書き、要約、翻訳などの作業を任せます。`profile`でphp、docker、git、code_reviewの定型の指示を選べます                    | `DEFAULT_MODEL` |
| `ollama_review_code`   | コードを確かめます。行番号付きで「重大度、行、問題、改善案」を返します                                                    | `DEEP_MODEL`    |
| `ollama_explain_error` | エラーやログの原因の候補と対処を返します                                                                                  | `DEEP_MODEL`    |
| `ollama_list_models`   | 入っているモデルの一覧を返します                                                                                          | -               |
| `ollama_health`        | Ollamaが動いているかと、サーバーの設定を返します                                                                          | -               |
| `list_files`           | 許可ルートの中のファイルとディレクトリを一覧します。`files`に渡すパスを探すときに使います。ファイルを扱えるときだけ出ます | -               |
| `read_file`            | 1つのファイルを、ローカルのモデルに渡さずにそのまま読みます。`save_output`で書いた結果を読み返すときに使います。ファイルを扱えるときだけ出ます | -               |
| `git_clone`            | GitHubのリポジトリを`CLONE_ROOT`の配下に取得します。`owner/repo`だけを受け、URLは受けません。`CLONE_ROOT`を設定したときだけ出ます | -               |
| `git_read`             | 取得したリポジトリの状態を読みます。`status`、`log`、`diff`、`show`、`branches`、`remotes`です | -               |
| `git_write`            | ブランチの作成、staging、commit、pushです。`GIT_ALLOW_WRITE=true`にしたstdioでだけ出ます | -               |
| `github_read`          | Pull RequestとIssueと差分とコメントとチェックを読みます。`GITHUB_MCP_TOKEN`を設定したときだけ出ます | -               |
| `github_write`         | Pull Requestの作成とコメントです。`GITHUB_ALLOW_WRITE=true`にしたstdioでだけ出ます | -               |

- ファイルを扱えるとき（stdioと、設定したHTTP）は、`files`引数にWindowsの絶対パスを渡すと、サーバーがファイルを読み込みます。Claudeはファイルの中身を引数として書き出さずに済むため、トークンを節約できます
- `files`は、1つのパスのほかにグロブと行範囲も取ります
  - グロブは`C:\dev\app\src\**\*.php`のように書きます。`list_files`で探してから渡す往復を省けます
  - 行範囲は`C:\dev\app\src\Main.php#L10-200`のように末尾に付けます。GitHubの永続リンクと同じ書き方です。`#L10`は1行、`#L10-`は末尾までです
  - ディレクトリをそのまま渡すことはできません。グロブの書き方を添えて拒みます
- `inline_files`には、サーバーが読めないファイルの中身を`{"name": ..., "content": ...}`の形で渡します。許可ルートの外にあるファイルや、Claudeが別の環境で開いているファイルに使います
  - これはトークンを節約しません。`content`の分はどちらにせよ払います。サーバーが読めるパスなら必ず`files`を使います
- 渡せる量の上限は、文字数ではなくトークン数の目安で測ります。日本語のコメントが多いコードは1文字がほぼ1トークンになるためです
  - 上限を超えた分は丸ごと落とし、落としたファイル名を応答とプロンプトの両方に書きます。黙って切りません
- `list_files`は`pattern`にグロブを取ります。大文字と小文字は区別しません
  - `*`は直下、`**/*.php`は下の階層のPHPのファイル、`*.{js,ts}`は選択肢、末尾の`/`はディレクトリだけです
  - `**`でたどるのは`path`から8階層までです。それより深いときは、そのことを結果に書き添えます
  - 秘密のファイルと、`node_modules`、`vendor`、`.git`は出しません。シンボリックリンクはたどりません
- `model`には、モデルの名前の代わりに別名`fast`（`DEFAULT_MODEL`）と`deep`（`DEEP_MODEL`）を渡せます。入っていないモデルを渡したときは、入っているモデルの一覧を添えて返します
- 応答の末尾に`[ollama] model=... prompt_tokens=... output_tokens=... done_reason=... elapsed=...`が付きます。`done_reason=length`や`done_reason=timeout`のときは、出力が途中で切れています
- 小さいモデルは同じ内容を繰り返し続けることがあるため、出力のトークン数に上限を設けています。`ollama_chat`は4096、ほかの2つは1536で、`max_tokens`で変えられます
- ローカルのモデルの出力は誤りを含みます。Claudeの側で確かめてから使います

## セットアップ

### コンテナーを起動する

```powershell
docker compose up -d --build
```

`restart: unless-stopped`のため、Docker Desktopを起動すると一緒に立ち上がります。

### Claude Desktopに登録する

`%APPDATA%\Claude\claude_desktop_config.json`の`mcpServers`に次を足し、Claude Desktopを終了してから起動し直します。
チャットとCodeタブの両方で使えます。

```json
{
  "mcpServers": {
    "ollama": {
      "command": "docker",
      "args": ["exec", "-i", "ollama-mcp", "node", "stdio.ts"]
    }
  }
}
```

Claude Codeだけで使う場合は、次のコマンドでも登録できます。

```powershell
claude mcp add --scope user ollama -- docker exec -i ollama-mcp node stdio.ts
```

### サブエージェントを入れる

`claude/agents/ollama-worker.md`を`%USERPROFILE%\.claude\agents\`に写すと、Claude Codeから`ollama-worker`のサブエージェントとして呼べます。
Ollamaに作業を任せ、その結果をClaudeが確かめてから返すための指示です。

ツールを呼ぶたびの確認を省く場合は、`%USERPROFILE%\.claude\settings.json`の`permissions.allow`に`mcp__ollama__*`を足します。
`OUTPUT_DIR`を設定しないかぎり、どのツールもファイルを書き換えません。
設定したときに書くのは`OUTPUT_DIR`の配下だけで、読み込みのツールは何も書き換えません。

## 環境変数

`.env`に書きます。
`docker-compose.yml`は`.env`の値を差し込むことにだけ使い、次の変数だけをコンテナーに渡します。

| 変数                                     | 既定値                                                         | 説明                                                                                                                                               |
|------------------------------------------|----------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| `OLLAMA_URL`                             | `http://host.docker.internal:11434`                            | OllamaのURLです                                                                                                                                    |
| `DEFAULT_MODEL`                          | `nucbox-fast:latest`                                           | `ollama_chat`の既定のモデルです                                                                                                                    |
| `DEEP_MODEL`                             | `qwen2.5-coder:14b`                                            | コードの確認とエラーの解析の既定のモデルです                                                                                                       |
| `OLLAMA_TIMEOUT`                         | `300000`                                                       | Ollamaから何も届かない状態の上限（ミリ秒）です。キューの待ち、モデルの読み込み、プロンプトの評価も含みます                                         |
| `OLLAMA_MAX_DURATION`                    | `3000000`                                                      | 1回の生成全体の上限（ミリ秒）です                                                                                                                  |
| `OLLAMA_MAX_CONCURRENCY`                 | `2`                                                            | 同時に走らせる生成の数です。OllamaはGPUを1つずつ使うため、並べても全体は速くなりません                                                             |
| `OLLAMA_MAX_QUEUE`                       | `8`                                                            | 待ち行列の長さの上限です。ここも一杯なら、待たせずにその場で断ります                                                                              |
| `HTTP_REQUEST_TIMEOUT`                   | `60000`                                                        | HTTPの要求を受け取り終えるまでの上限（ミリ秒）です。応答を返している時間（生成の時間）には効きません                                              |
| `ALLOWED_HOSTS`                          | `localhost,127.0.0.1,[::1],host.docker.internal,mcp.223n.tech` | HTTPで受け付ける`Host`と`Origin`です                                                                                                               |
| `HTTP_ALLOW_FILES`                       | `false`                                                        | HTTPでもファイルの読み込みを許すかどうかです。認証（`MCP_AUTH_TOKEN`か`CF_ACCESS_*`）がないときは無視します                                        |
| `MCP_AUTH_TOKEN`                         | なし                                                           | 設定すると、HTTPに`Authorization: Bearer <値>`を求めます                                                                                           |
| `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD` | なし                                                           | 設定すると、HTTPにCloudflare AccessのJWT（`Cf-Access-Jwt-Assertion`）を求めます                                                                    |
| `CF_ACCESS_ALLOWED_EMAILS`               | なし                                                           | 設定すると、AccessのJWTの`email`がこの一覧にある人だけを通します。カンマで区切って並べます。サービストークンのJWTには`email`がないため、拒まれます |
| `FILE_ROOTS`                             | `docker-compose.yml`で設定                                     | `ホストのパス=コンテナのパス`を`;`で区切って並べます                                                                                               |
| `OUTPUT_DIR`                             | なし                                                           | ローカルのモデルの出力を書き出す先です。`ホストのパス=コンテナのパス`を1件だけ書きます。設定したときだけ`save_output`が出ます                     |
| `HTTP_ALLOW_WRITES`                      | `false`                                                        | HTTPでも書き出しを許すかどうかです。`HTTP_ALLOW_FILES`とは別に持ちます。認証がないときは無視します                                                 |
| `CLONE_ROOT`                             | `docker-compose.yml`で設定                                     | リポジトリを取得する先です。`ホストのパス=コンテナのパス`を1件だけ書きます。サーバーが書き換えてよいのはここの配下だけです                         |
| `GIT_ALLOWED_OWNERS`                     | `docker-compose.yml`で設定                                     | 取得してよいGitHubのownerです。カンマで区切って並べます。空なら取得そのものを拒みます                                                             |
| `GIT_ALLOW_WRITE`                        | `false`                                                        | commitとpushを許すかどうかです。stdioでだけ効き、HTTPでは常に無効です                                                                             |
| `GIT_TIMEOUT`、`GIT_MAX_DURATION`        | `120000`、`600000`                                             | gitから何も届かない状態の上限と、1回の操作全体の上限です（ミリ秒）                                                                                |
| `GIT_USER_NAME`、`GIT_USER_EMAIL`        | なし                                                           | commitに使う名前とメールアドレスです。commitするなら両方とも要ります                                                                              |
| `GITHUB_MCP_TOKEN`                       | なし                                                           | GitHubのAPIに使うトークンです。fine-grainedを使い、対象のリポジトリを列挙します                                                                   |
| `GITHUB_ALLOW_WRITE`                     | `false`                                                        | Pull Requestの作成とコメントを許すかどうかです。stdioでだけ効き、HTTPでは常に無効です                                                             |

- タイムアウトしても、それまでに生成された部分は`done_reason=timeout`と警告を付けて返します
- 無通信の上限（`OLLAMA_TIMEOUT`）は300秒のままです。全体の上限だけを延ばし、Ollamaが固まったときは早く気付けるようにしています
- `ollama_health`と`ollama_list_models`の問い合わせは、`OLLAMA_TIMEOUT`と15秒の短いほうで打ち切ります。Ollamaが固まったときに、状態の確認そのものが300秒待たないようにするためです
- HTTPの`requestTimeout`（`HTTP_REQUEST_TIMEOUT`）は、要求を受け取り終えるまでの上限です。応答を返している時間には効かないため、長い生成のために上げる必要はありません。起動時に`[http] request timeout`として出します
  - 以前は`OLLAMA_MAX_DURATION`+60秒に合わせていましたが、Node 22と26で、`requestTimeout`より長い応答が切れないことを確かめたうえで切り離しました。長くしておくと、本文をゆっくり送り続ける相手に、その間ずっと接続をつかまれます
- 認証は、本文を読む前に確かめます。認証のない要求は、本文を解析せずに401を返します
- 失敗した要求（状態コードが400以上）が同じ接続元から1分に60回を超えると、その接続元からの要求を1分ほど429で断ります。偽のトークンの連打で、重い認証の処理を回させないためです
  - 成功した要求は数えません。認証を通った普段の利用は妨げません
  - 接続元は相手のIPで見分け、`X-Forwarded-For`は信じません。Cloudflare Tunnelを通る要求は、どれもcloudflaredから届くため、同じ枠を分け合います
  - 3000秒まで使えるのはstdioと、同じPCから直にHTTPを叩くときです。claude.aiのコネクタは約240秒、Cloudflareは無通信が約100秒で打ち切ります
- `MCP_AUTH_TOKEN`と`CF_ACCESS_*`の両方を設定したときは、どちらかを満たせば通します
- どちらも設定しないと、このPCのほかのコンテナーからも`host.docker.internal:3000`を通してHTTPを呼べます

## 動作を確かめる

```powershell
curl.exe http://127.0.0.1:3000/healthz
docker logs --tail 20 ollama-mcp
```

HTTPのアクセスログには、メソッド、パス、ステータス、`Host`、JSON-RPCのメソッドが出ます。
本文は記録しません。
トンネルを通したリクエストがサーバーまで届いているかを確かめるときに使います。

## リモートで使う

claude.aiから使うときは、Cloudflare TunnelとCloudflare Accessを前に置きます。

1. Cloudflare Tunnelで、公開するホスト名（例: `mcp.223n.tech`）を`http://127.0.0.1:3000`に向けます
1. Cloudflare Zero Trustで、そのホスト名に「Self-hosted」のAccessのアプリを1つだけ作ります
1. アプリに「Allow」のポリシーを足し、使う人のメールアドレスを入れます
1. アプリの「Managed OAuth」を有効にし、「Allowed redirect URIs」に`https://claude.ai/api/mcp/auth_callback`を足します
1. `.env`に`CF_ACCESS_TEAM_DOMAIN`とアプリの`CF_ACCESS_AUD`を書き、コンテナーを作り直します
1. claude.aiの「設定」の「コネクタ」で、`https://<ホスト名>/mcp`をカスタムコネクタとして足します

- claude.aiとClaude Desktopのリモートのコネクタは、1回の呼び出しを約240秒で打ち切ります。Cloudflareは応答が約100秒途切れると打ち切ります。長い生成はローカルで行います
- うまくつながらないときは[docs/troubleshooting.md](docs/troubleshooting.md)を見てください

### リモートでファイルを読む

HTTPでも、`files`引数と`list_files`を使えます。
認証がないまま有効にすると誰でもファイルを読めてしまうため、認証を設定したときだけ有効になります。

1. 前の手順で`CF_ACCESS_TEAM_DOMAIN`と`CF_ACCESS_AUD`を設定しておきます
1. `.env`に`HTTP_ALLOW_FILES=true`を足します
1. 使う人をさらに絞るときは、`.env`の`CF_ACCESS_ALLOWED_EMAILS`にメールアドレスを書きます
1. `docker compose up -d`でコンテナーを作り直します。ログに`File tools are enabled over HTTP`と出れば有効です。`CF_ACCESS_ALLOWED_EMAILS`を書いたときは、ログの`[auth]`の行に登録した件数が出ます
1. claude.aiの「設定」の「コネクタ」で、このコネクタのツールリストを更新します。`list_files`が加わり、`ollama_chat`などに`files`引数が付きます

- 読めるのは`FILE_ROOTS`の配下だけで、秘密のファイルを拒むのはstdioと同じです
- ファイルの中身はこのPCのOllamaにだけ渡ります。ただし、Ollamaの出力はclaude.aiに返るため、Anthropicのサービスを通ります
- `HTTP_ALLOW_FILES`を外したときも、ツールリストを更新します。更新しないと、Claudeがなくなったツールや引数を呼んで失敗します
- 大きなファイルを14Bのモデルに読ませると、1回の呼び出しの上限（約240秒）を超えることがあります。そのときは`DEFAULT_MODEL`の7Bのモデルを使うか、ファイルを分けます
- コネクタが約240秒で打ち切ったときは、途中まで生成された部分も返りません。リモートで主に使うなら、`OLLAMA_MAX_DURATION`を`200000`ほどに下げると、打ち切られる前に途中までの結果を返せます。ただし、同じコンテナーのstdioにも効きます

### 出力をファイルに保存する

長い下書きや翻訳は、`save_output`でファイルに書き出せます。
応答にはパスと先頭と末尾の抜粋だけが返るため、Claudeが全文を読まずに済みます。

1. ホスト側に書き出し先のディレクトリを作ります。コンテナーの`node`ユーザーが書ける権限にします
    - `docker-compose.yml`は`C:\dev`を読み取り専用でマウントし、`C:\dev\ollama-out`だけを読み書きできる形で重ねています。別の場所にするときは、`docker-compose.yml`の`volumes`も合わせます
1. `.env`に`OUTPUT_DIR=C:\dev\ollama-out=/work/dev/ollama-out`のように書きます
1. HTTPでも使うときは、認証を設定したうえで`HTTP_ALLOW_WRITES=true`を足します
1. `docker compose up -d`でコンテナーを作り直します。`ollama_health`の`output saving`が`enabled`になれば有効です

- ファイル名は`output_name`で指定します。使えるのは英数字と`_`と`-`だけで、`.`とパス区切りは拒みます
- 拡張子はサーバーが`.md`に決めます。`.php`や`.js`をサーバーに書かせないためです
- すでにあるファイルは上書きせず、`-2`、`-3`と後ろに足して新しく作ります
- 書き出したファイルの先頭には、ローカルのモデルが書いたものだという断りが入ります
- 書き出したファイルは`read_file`で読み返せます。`#L120-200`を付けると一部だけ読めます
- ローカルのモデルは同じ行を繰り返して終わることがあります。末尾の重複を数え、疑わしいときは警告を付けます

### MCPのリソースとして読む

ファイルを扱えるときは、MCPの`resources`としても同じファイルを公開します。
`resources/list`は許可ルートだけを返し、`resources/read`はディレクトリなら一覧を、ファイルなら中身を返します。

- URIは`file:///C:/dev/app/src/Main.php`の形です。`#L10-200`を付けると行範囲になります
- 防御は`files`引数とまったく同じ経路を通ります。許可ルートの外、`..`、秘密のファイル、シンボリックリンクは同じように拒みます
- `resources/read`にはツール名がないため、`mcp__ollama__*`の許可の対象になりません。そのぶん、ファイルのツールと完全に同じ条件でだけ公開します
- `resources/subscribe`とページングには対応していません。一覧は許可ルートだけに絞っています

### リポジトリを取得してgitとGitHubを操作する

`CLONE_ROOT`を設定すると、GitHubのリポジトリを取得して、そのままローカルのモデルにレビューさせられます。

1. ホスト側に取得先のディレクトリを作ります（例:`C:\dev\claude`）
    - `docker-compose.yml`は`C:\dev\claude`を読み書きできる形でマウントしています。別の場所にするときは、`docker-compose.yml`の`volumes`も合わせます
1. `.env`に`CLONE_ROOT`と`GIT_ALLOWED_OWNERS`を書きます
1. privateのリポジトリを扱うときは、fine-grainedのトークンを`GITHUB_MCP_TOKEN`に書きます。対象のリポジトリは列挙して絞ります
1. commitとpushまで任せるときは、`GIT_ALLOW_WRITE=true`、`GIT_USER_NAME`、`GIT_USER_EMAIL`を足します
1. Pull Requestの作成まで任せるときは、`GITHUB_ALLOW_WRITE=true`を足します
1. `docker compose up -d --build`でコンテナーを作り直します。`ollama_health`で状態を確かめられます

#### privateリポジトリを取得する

SSHの鍵は要りません。
`GITHUB_MCP_TOKEN`にfine-grainedのトークンを設定すると、HTTPS経由でそのまま取得できます。
サーバーはトークンを`x-access-token`のBasic認証としてgitに渡します。
子プロセスの環境変数だけで渡すため、argvに現れず、`.git/config`にも残りません。

1. GitHubの「Settings」→「Developer settings」→「Personal access tokens」→「Fine-grained tokens」で発行します
1. 「Resource owner」に、対象のリポジトリを持つ利用者か組織を選びます
1. 「Repository access」は「Only select repositories」にして、**使うリポジトリだけを選びます**
1. 「Repository permissions」を次のように設定します

    | 権限 | 必要な場面 |
    |------|------------|
    | Metadata: Read | 必須です。ほかの権限を選ぶと自動で付きます |
    | Contents: Read | `git_clone`です。pushもするならRead and write |
    | Pull requests: Read | `pr_list`、`pr_view`、`pr_diff`、`pr_comments`です。PRを作るならRead and write |
    | Issues: Read | `issue_list`、`issue_view`です。コメントするならRead and write |
    | Checks: Read | `pr_checks`です |

1. `.env`に`GITHUB_MCP_TOKEN=github_pat_...`と書き、`docker compose up -d`で作り直します
1. `ollama_health`の`github api`が`enabled`になれば有効です

トークンを設定していないと、privateリポジトリの取得は`Repository not found`で失敗します。
GitHubが認証のない要求に404を返すためで、名前の打ち間違いと見分けが付きません。
サーバーはこのとき、トークンが未設定であることを書き添えます。

- 取得先は`CLONE_ROOT/owner/repo`です。パスは`owner`と`repo`から組み立てるため、渡した文字列がパスの区切りとして働く余地がありません
- URLは受け取りません。`owner/repo`だけを受け、`https://github.com/owner/repo.git`はサーバーが組み立てます
- 取得したリポジトリは`list_files`と`files`と`read_file`から読めます。ローカルのモデルにレビューさせる目的なので、これは意図した動きです
- **書き込みはstdioでだけ有効です。** `GIT_ALLOW_WRITE`と`GITHUB_ALLOW_WRITE`をtrueにしても、HTTP経由では`git_write`と`github_write`が出ません
- `main`、`master`、`develop`への直pushは、設定にかかわらず拒みます。それらをheadにしたPull Requestの作成も拒みます
- `gh`コマンドは入れていません。GitHubのRESTのAPIを直に呼ぶため、`gh api`や`gh alias`のような別の実行経路がそもそもありません

### 監査ログ

サーバーはファイルを書き、リポジトリを取得し、pushし、Pull Requestを作れます。
何が行われたかを後から言えるよう、ツールの呼び出しを1行1JSONで記録します。

```json
{"ts":"2026-09-22T12:00:00.000Z","identity":"you@example.com","kind":"tool","tool":"git_write","ok":true,"ms":842,"args":{"repo":"223n/mcp-server","op":"push","branch":"feature/x"}}
```

- 出力先は標準エラーです。stdioのとき標準出力はMCPの通信路なので、そちらには出しません
- `identity`は、Cloudflare AccessのJWTの`email`、サービストークンなら`service:<クライアントID>`、静的なトークンなら`token`、stdioなら`stdio`です。認証がない構成では`anonymous`になります
- `args`には記録してよい鍵だけを残します。`prompt`、`code`、`system`、`context`、`message`、`body`、`inline_files`の中身は出しません
  - 渡したファイルのパス（`files`と`paths`）は残します。何をローカルのモデルに渡したかは、監査でいちばん知りたいことだからです
  - `inline_files`は件数だけにします。名前と中身のどちらも呼び出し側が決めるためです
- `resources/read`にはツール名がなく、ツールの記録に載りません。読み取りの経路としては同じ重さなので、`"kind":"resource"`として別に記録します
- Dockerでは`docker logs ollama-mcp`で見られます。ログは10MBを3世代まで残します

### 同時に走らせる数を絞る

OllamaはGPUを1つずつ使うため、生成を並べて投げても待ち行列に並ぶだけで、全体は速くなりません。
待っている間もクライアントの上限（claude.aiは約240秒）は進みます。

- `OLLAMA_MAX_CONCURRENCY`（既定2）までを同時に走らせ、それを超えた分は`OLLAMA_MAX_QUEUE`（既定8）まで待ち行列に並べます
- 待ち行列も一杯のときは、待たせずにその場で断ります。Claudeを長く待たせず、早く判断できるようにするためです
- 待っている間は、進捗の通知で「何件待ちか」を伝えます
- 今の状態は`ollama_health`の`concurrency`に出ます

## セキュリティ

- `.env`はコミットしません。`.gitignore`で外しています
- Ollama（11434番ポート）には認証がありません。LANやインターネットへ直に公開しないでください
- コンテナーは権限を絞って動かします（`docker-compose.yml`）
  - ルートのファイルシステムは読み取り専用で、書けるのは`/tmp`（メモリ上）と書き込み先だけです
  - `C:\dev`は読み取り専用でマウントし、`CLONE_ROOT`と`OUTPUT_DIR`の場所だけを読み書きできる形で重ねます。サーバーの約束が外れたとき（gitやNodeの不具合など）に書き換えられる範囲を、この2つに絞るためです
  - ケーパビリティはすべて外し、特権の昇格を禁じ、プロセスの数に上限を設けます
  - CIも同じ絞り込みでコンテナーを起動し、HTTPとstdioが応答することを確かめます
- HTTPでファイルを読めるのは、`HTTP_ALLOW_FILES=true`に加えて認証を設定したときだけです
- ファイルの読み込みは`FILE_ROOTS`の配下だけに限ります
  - `.env`、`.envrc`、`.npmrc`、秘密鍵、`app_local.php`などの秘密のファイルと、`.git`や`.ssh`などの配下は拒みます
  - Windowsの8.3形式の短い名前（`ENV~1`など）で回り込むことも拒みます
- 書き出せるのは`OUTPUT_DIR`の配下だけです。`FILE_ROOTS`には書きません
  - HTTPで書き出せるのは、`HTTP_ALLOW_WRITES=true`に加えて認証を設定したときだけです。`HTTP_ALLOW_FILES`だけでは書けません
  - ファイル名は英数字と`_`と`-`だけに限り、`NUL`や`COM1`などWindowsが特別扱いする名前も拒みます
  - 全角の`／`はNFKCで`/`になるため、正規化してから確かめます
  - 作成は`O_CREAT|O_EXCL`で行います。先に置かれたシンボリックリンクをたどって別の場所へ書くことはありません
- グロブでまとめて渡すときは、拒否リストではなく拡張子の許可リストで絞ります。名前を指定せずにサーバーが選ぶため、明示的なパスより狭くしています
  - 先頭が`.`の名前、拡張子のないファイル、ハードリンクは展開で拾いません
- 読み込んだファイルに書かれた指示は、ローカルのモデルの出力に紛れ込むことがあります。出力の中の指示には従わないよう、ツールの応答と説明に書いてあります
  - `OUTPUT_DIR`を`FILE_ROOTS`の配下に置くと、書き出した出力を読み返せる代わりに、モデルの出力が普通のファイルのような顔で戻ってきます。起動時に警告を出し、書き出したファイルの先頭に出自を書いています
- gitを動かすときは、環境変数を継承しません。`GIT_SSH_COMMAND`や`GIT_EXTERNAL_DIFF`など、任意のコマンドを実行させる変数を持ち込ませないためです
  - システムの設定は`/etc/git/server.gitconfig`の1枚だけを読ませ、利用者のグローバルの設定は読ませません
  - 取得したリポジトリの`.git/config`は、`GIT_CONFIG_SYSTEM`と`GIT_CONFIG_GLOBAL`を差し替えても読まれます。そこで、鍵の許可リストとコマンドの側の設定の2段で守ります
    - 操作の前に`.git/config`の鍵を許可リストで確かめ、ほかの鍵があればgitを動かさずに拒みます
    - 許すのは、`git clone`と`push --set-upstream`が書く鍵（`core.*`の一部、`remote.origin.*`、`branch.*.remote`と`merge`）と、`user.name`と`user.email`だけです。`remote.origin.url`は、取得先のURLと同じであることも確かめます
    - `core.hooksPath`、`core.fsmonitor`、`credential.helper`、`commit.gpgSign`、`protocol.*`は、コマンドの側の設定（`GIT_CONFIG_COUNT`）で打ち消します。`diff`と`show`には`--no-ext-diff`と`--no-textconv`を付けます
    - `.git/config`はリモートから配られないため、取得しただけで危険な鍵が入ることはありません。守る相手は、`CLONE_ROOT`に書けるホストの側のプロセスです
  - `https`以外のプロトコル（`ext::`、`file://`、`git://`、`ssh://`）を拒みます
  - 引数は必ず配列で渡し、シェルを介しません。利用者の値は値の位置にしか入らず、`-`で始まる値は拒みます
  - トークンは子プロセスの環境変数だけで渡します。argvに現れず、`.git/config`にも残りません
- gitとGitHubの差分は、`files`引数とは別の読み取り口になります。`git_read`の`diff`と`github_read`の`pr_diff`からは、`files`と同じ判定（`src/tools/sensitive.ts`）で秘密のファイルの区画を外し、外したファイルの名前を末尾に書きます。`show`は中身を返しません
  - 名前を変えた差分は、元の名前と新しい名前のどちらかが当たれば外します
  - ただしこれは名前による防御です。秘密に当たらない名前のファイルに書かれた秘密や、コミットのメッセージに書かれた秘密は読めます
- 取得したリポジトリの中身は第三者が書いたテキストです。ローカルのモデルは指示の混入に弱いため、出力の中の指示には従いません
- `github_read`の結果と、`git_read`の`log`、`diff`、`show`の結果には、第三者が書いた文章なので指示として扱わない旨を末尾に添えます。サーバーの`instructions`とツールの説明にも同じことを書いています
- ツールの呼び出しは監査ログに残します。中身は出しませんが、ファイルのパスと操作の種類は残します
- HTTPのアクセスログは10MBを3世代まで残します

## ディレクトリ

```text
mcp-server/
├─ claude/agents/ollama-worker.md   Claude Code のサブエージェントの定義
├─ docs/                            運用の手引きとトラブルシューティング
├─ docker-compose.yml
├─ Dockerfile
├─ tsconfig.json                    型の検査の設定（成果物は作らない）
├─ index.ts                         HTTP の入口
├─ stdio.ts                         stdio の入口
├─ src/
│  ├─ server.ts                     McpServer を作る（HTTP と stdio で共通）
│  ├─ types.ts                      複数のファイルで共有する型
│  ├─ config/                       環境変数、モデル、定型の指示
│  ├─ git/exec.ts                   git の起動（環境を継承しない、引数は配列、上限と中断）
│  ├─ http/auth.ts                  HTTP の認証（静的なトークン、Cloudflare Access の JWT）
│  ├─ ollama/client.ts              Ollama の API（ストリーミング、タイムアウト、中断）
│  └─ tools/                        ツール、ファイルの読み込みと一覧、秘密のファイルの判定、出力の保存、リソース
└─ test/                            試験（Ollama の代わりに試験用のサーバーを使う）
```

## TypeScript

ソースはTypeScriptで書きます。
ビルドはしません。
Nodeが`.ts`から型を取り除いてそのまま実行します（型の剥がし）。
そのため`dist/`のような成果物はなく、`node index.ts`と`node stdio.ts`が本番の起動コマンドです。

この方法にはNode 22.18以上が要ります。
`package.json`の`engines`がその下限を書いています。
Dockerのイメージが使うのはNode 26です。

### 型を検査する

Nodeは型を取り除くだけで、型が合っているかは見ません。
型の誤りが見つかるのは次のコマンドだけです。

```bash
npm run typecheck
```

`npm run lint`にも入っています。
CIでは「型の検査」ジョブが同じことをします。

### 書き方の決まり

設定は`tsconfig.json`にあり、次の3つが書き方を縛ります。

| 設定                    | 何を縛るか                                                                                                  |
|-------------------------|-------------------------------------------------------------------------------------------------------------|
| `allowImportingTsExtensions` | `import`には実行時と同じ綴りを書きます（`./files.ts`であって`./files.js`ではありません）                |
| `verbatimModuleSyntax`  | 型だけを取り込むときは`import type`と書きます。こう書かないとNodeが値の取り込みと区別できません              |
| `erasableSyntaxOnly`    | `enum`、`namespace`、コンストラクターのパラメータープロパティは使えません。取り除くだけでは消えないためです |

`strict`と`noUncheckedIndexedAccess`を有効にしています。
`arr[0]`や`obj[key]`の型には`undefined`が入ります。
取り出した値は、そのまま使わずに確かめてください。

複数のファイルで使う型は`src/types.ts`に置きます。
MCPの通信で使う形は写さず、SDKの型（`@modelcontextprotocol/server`）をそのまま使います。

## 試験

`npm test`で試験します。
Ollamaの代わりに試験用のサーバー（`test/helpers/mock-ollama.ts`）を使うため、GPUとOllamaは要りません。

```bash
npm install
npm test
```

次のことを確かめます。

- HTTPとstdioで、MCPの2025年版と2026-07-28版の両方につながること
- ファイルの読み込みの防御（許可ルートの外、`..`、シンボリックリンク、秘密のファイル、大きさの上限）と、`list_files`の絞り込み
- 同じ防御が、グロブの展開と`resources/read`でも働くこと
- 行範囲の切り出しで、行番号が元のファイルのまま振られること
- `inline_files`の名前で、見出しやフェンスを偽装できないこと
- 書き出しの防御（パス区切り、`..`、二重の拡張子、Windowsの装置名、全角の区切り、置かれたシンボリックリンク）
- 認証のないHTTPで、`resources`も書き出しの引数も出ないこと
- `owner/repo`の検証（`..`、パスの区切り、Windowsの装置名、`.git`で終わる名前、URL）
- `-`で始まる値をgitの引数として拒むこと
- 守るブランチへのpushと、それらをheadにしたPull Requestの作成を拒むこと
- `git_read`の`diff`と`github_read`の`pr_diff`から、`files`が拒むのと同じ秘密のファイルが外れること（名前の変更、引用符で囲まれた名前を含む）
- 取得したリポジトリの`.git/config`に許可していない鍵（`core.fsmonitor`、`core.hooksPath`、`diff.external`、`include.path`など）があれば、gitを動かさずに拒むこと
- 許可リストを通り抜けても、フックと`core.fsmonitor`がコマンドの側の設定で止まること
- `github_read`と`git_read`の`log`、`diff`、`show`の結果に第三者の文章だという断り書きが付き、`status`と空の差分には付かないこと
- HTTPでは`git_write`と`github_write`を出さないこと
- 監査ログに`prompt`や`code`の中身が出ず、識別子とファイルのパスは出ること
- `resources/read`で復号できないURI（壊れた符号化、NUL）を拒んだときも、監査ログに残ること
- 同時に走らせる数の上限と、待ち行列が一杯のときに断ること
- すでに中断された呼び出しを待ち行列に並ばせないことと、枠を渡す間にも上限を超えて走らないこと
- HTTPの認証（静的なトークン、Cloudflare AccessのJWT、メールアドレスの絞り込み）と、エラーの形
- Cloudflare Accessの鍵の取得を、同時に届いた知らない`kid`のJWTで分け合い、失敗した直後は取り直さないこと
- クライアントからの中断と、stdioのstdinが閉じたときに、Ollamaへの呼び出しが止まること
- `OLLAMA_MAX_DURATION`を超えたときに、途中までの出力を警告付きで返し、Ollamaへの呼び出しも止まること
- HTTPの`requestTimeout`より長い生成が、途中で切れずに最後まで返ること
- Ollamaが固まったとき、状態の確認が短い上限で打ち切られ、効いた上限の名前を知らせること
- 認証を設定したHTTPで、認証のない要求には本文を読み終える前に401を返すこと
- 失敗した要求が1分に60回を超えると429で断り、成功した要求は数えないこと
- `list_files`のグロブが、`*`を並べた意地の悪いパターンでもすぐ終わること（ReDoSを防ぐ）
- ツールの説明に決め打ちのモデルの名前が出ず、別名`fast`と`deep`が設定したモデルに読み替わること。入っていないモデルには一覧を添えて返すこと
- サーバーが読む環境変数を、`docker-compose.yml`がすべてコンテナーに渡していること
- `docker-compose.yml`がコンテナーの権限を絞り、`C:\dev`を読み取り専用にして、書き込み先だけを読み書きできる形で重ねていること。CIが同じ絞り込みで起動すること
- 環境変数の不正な値で、起動時に止まること

CIは、Node 22と26で試験し、Dockerのイメージを作って起動したうえでHTTPとstdioの応答を確かめます。
あわせてTrivyでイメージの脆弱性を見ます。
`apk`で入れたパッケージの版はDependabotが追わないため、ここで拾います。
直せるもの（上流に修正がある高・重大）が見つかると失敗し、直せないものは記録に残すだけにします。

## リポジトリの運用

ブランチの運用、リリース、ラベル、ワークフローは[docs/repository-operations.md](docs/repository-operations.md)にあります。
変更の進め方は[CONTRIBUTING.md](CONTRIBUTING.md)にあります。

変更したら`npm run lint`を通します。
型の検査（`tsc --noEmit`）、Markdownの書式、日本語の書き方をまとめて確かめます。
文書だけを変えたときも型の検査が先に走ります。
ここで落ちたら`npm run typecheck`を単体で実行し、どちらの検査が落ちたかを切り分けてください。

```bash
npm install
npm run lint
```

## ライセンス

Apache License 2.0です。
[LICENSE](LICENSE)を見てください。
