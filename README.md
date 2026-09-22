# mcp-server

ローカルのOllamaをMCPサーバーとして公開し、Claudeから作業を任せられるようにするNode.jsのサーバーです。
公式のMCP TypeScript SDK v2で作っています。

入口は次の2つです。
どちらもMCPの2026-07-28版（`server/discover`）と2025年版（`initialize`）の両方に応答します。

| 入口                                               | 用途                                                              | ファイルの読み込み                                          | 出力の保存                                                   |
|----------------------------------------------------|-------------------------------------------------------------------|-------------------------------------------------------------|--------------------------------------------------------------|
| stdio（`docker exec -i ollama-mcp node stdio.js`） | 同じPCのClaude CodeとClaude Desktopから使います。こちらを勧めます | 使えます（`FILE_ROOTS`の配下だけ）                          | `OUTPUT_DIR`を設定したときだけ使えます                       |
| HTTP（`POST /mcp`、ポート3000）                    | Cloudflare Tunnelを通して、claude.aiなどから使います              | `HTTP_ALLOW_FILES=true`と認証を両方設定したときだけ使えます | `HTTP_ALLOW_WRITES=true`と認証と`OUTPUT_DIR`が要ります       |

## 構成

```text
[ローカル]
Claude Code / Claude Desktop ──stdio──> docker exec ollama-mcp node stdio.js ──> Ollama（ホストの11434番）

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
      "args": ["exec", "-i", "ollama-mcp", "node", "stdio.js"]
    }
  }
}
```

Claude Codeだけで使う場合は、次のコマンドでも登録できます。

```powershell
claude mcp add --scope user ollama -- docker exec -i ollama-mcp node stdio.js
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
| `OLLAMA_MAX_DURATION`                    | `900000`                                                       | 1回の生成全体の上限（ミリ秒）です                                                                                                                  |
| `ALLOWED_HOSTS`                          | `localhost,127.0.0.1,[::1],host.docker.internal,mcp.223n.tech` | HTTPで受け付ける`Host`と`Origin`です                                                                                                               |
| `HTTP_ALLOW_FILES`                       | `false`                                                        | HTTPでもファイルの読み込みを許すかどうかです。認証（`MCP_AUTH_TOKEN`か`CF_ACCESS_*`）がないときは無視します                                        |
| `MCP_AUTH_TOKEN`                         | なし                                                           | 設定すると、HTTPに`Authorization: Bearer <値>`を求めます                                                                                           |
| `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD` | なし                                                           | 設定すると、HTTPにCloudflare AccessのJWT（`Cf-Access-Jwt-Assertion`）を求めます                                                                    |
| `CF_ACCESS_ALLOWED_EMAILS`               | なし                                                           | 設定すると、AccessのJWTの`email`がこの一覧にある人だけを通します。カンマで区切って並べます。サービストークンのJWTには`email`がないため、拒まれます |
| `FILE_ROOTS`                             | `docker-compose.yml`で設定                                     | `ホストのパス=コンテナのパス`を`;`で区切って並べます                                                                                               |
| `OUTPUT_DIR`                             | なし                                                           | ローカルのモデルの出力を書き出す先です。`ホストのパス=コンテナのパス`を1件だけ書きます。設定したときだけ`save_output`が出ます                     |
| `HTTP_ALLOW_WRITES`                      | `false`                                                        | HTTPでも書き出しを許すかどうかです。`HTTP_ALLOW_FILES`とは別に持ちます。認証がないときは無視します                                                 |

- タイムアウトしても、それまでに生成された部分は`done_reason=timeout`と警告を付けて返します
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

## セキュリティ

- `.env`はコミットしません。`.gitignore`で外しています
- Ollama（11434番ポート）には認証がありません。LANやインターネットへ直に公開しないでください
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
- HTTPのアクセスログは10MBを3世代まで残します

## ディレクトリ

```text
mcp-server/
├─ claude/agents/ollama-worker.md   Claude Code のサブエージェントの定義
├─ docs/                            運用の手引きとトラブルシューティング
├─ docker-compose.yml
├─ Dockerfile
├─ index.js                         HTTP の入口
├─ stdio.js                         stdio の入口
├─ src/
│  ├─ server.js                     McpServer を作る（HTTP と stdio で共通）
│  ├─ config/                       環境変数、モデル、定型の指示
│  ├─ http/auth.js                  HTTP の認証（静的なトークン、Cloudflare Access の JWT）
│  ├─ ollama/client.js              Ollama の API（ストリーミング、タイムアウト、中断）
│  └─ tools/                        ツール、ファイルの読み込みと一覧、出力の保存、リソース
└─ test/                            試験（Ollama の代わりに試験用のサーバーを使う）
```

## 試験

`npm test`で試験します。
Ollamaの代わりに試験用のサーバー（`test/helpers/mock-ollama.js`）を使うため、GPUとOllamaは要りません。

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
- HTTPの認証（静的なトークン、Cloudflare AccessのJWT、メールアドレスの絞り込み）と、エラーの形
- クライアントからの中断と、stdioのstdinが閉じたときに、Ollamaへの呼び出しが止まること
- `OLLAMA_MAX_DURATION`を超えたときに、途中までの出力を警告付きで返し、Ollamaへの呼び出しも止まること
- `list_files`のグロブが、`*`を並べた意地の悪いパターンでもすぐ終わること（ReDoSを防ぐ）
- サーバーが読む環境変数を、`docker-compose.yml`がすべてコンテナーに渡していること
- 環境変数の不正な値で、起動時に止まること

CIは、Node 22と26で試験し、Dockerのイメージを作って起動したうえでHTTPとstdioの応答を確かめます。

## リポジトリの運用

ブランチの運用、リリース、ラベル、ワークフローは[docs/repository-operations.md](docs/repository-operations.md)にあります。
変更の進め方は[CONTRIBUTING.md](CONTRIBUTING.md)にあります。

文書を変えたら、`npm run lint`で日本語の書き方を確かめます。

```bash
npm install
npm run lint
```

## ライセンス

Apache License 2.0です。
[LICENSE](LICENSE)を見てください。
