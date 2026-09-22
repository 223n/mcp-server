# CLAUDE.md

このリポジトリで作業するときの決まりです。
Claude Codeがこのファイルを読みます。
人が読む手引きは[CONTRIBUTING.md](CONTRIBUTING.md)、[README.md](README.md)、[docs/repository-operations.md](docs/repository-operations.md)にあります。

## mainとdevelopをPull Requestのheadにしない

このリポジトリは「Automatically delete head branches」を有効にします。
`scripts/setup.sh`が設定します（「Settings」→「General」→「Pull Requests」）。
GitHubの文書は、この設定を「head branches automatically deleted after pull requests are merged」と説明しています。

消えるのはheadブランチだけで、baseブランチは消えません。
そのため、`main`や`develop`をheadにしたPull Requestを作ると、マージでそのブランチごと失う恐れがあります。

| Pull Request     | headブランチ | マージすると                    |
|------------------|--------------|---------------------------------|
| `develop`→`main` | `develop`    | `develop`が消える恐れがあります |
| `main`→`develop` | `main`       | `main`が消える恐れがあります    |

`develop`が消えると、リリースのワークフローが最初の確認で止まります。
`release.yml`が`develop`の存在をAPIで確かめ、無ければ`develop ブランチが無い`と出して終わるためです。
Dependabotの`target-branch`、ラベル同期の`--ref`、CIの`push`トリガーも`develop`を指しています。

### 代わりにすること

`develop`の内容を`main`へ出すときは、Actionsの「リリース」を実行します。
ワークフローが`release/vX.Y.Z`ブランチを切り、そこをheadにしてPull Requestを開きます。

`main`の内容を`develop`へ戻すときは、「リリースを公開する」ワークフローに任せます。
直接pushできないときは、ワークフローが`merge/vX.Y.Z-into-develop`ブランチからPull Requestを開きます。

どちらもheadは`release/*`か`merge/*`で、`develop`や`main`ではありません。

ワークフローの外で取り込む必要があるときは、作業用のブランチを切ってからPull Requestを開きます。

```bash
git switch --create merge/main-into-develop origin/main
git push --set-upstream origin merge/main-into-develop
gh pr create --base develop --head merge/main-into-develop --title "main を develop に取り込む"
```

### gh pr mergeに--delete-branchを付けない

`gh pr merge --delete-branch`は、リポジトリの設定とは別に、手元とリモートの両方のブランチを消しにいきます。
`main`や`develop`がheadのPull Requestには使わないでください。

### 自動削除を止める設定

GitHubの文書は「Branch protection rules and repository rules can also prevent branches being automatically deleted.」と書いています。
`scripts/setup.sh`が「ブランチの削除を禁止する」ルールセットを作り、`main`と`develop`にかけます。
ルールは「Restrict deletions」（APIの`deletion`）です。

ルールセットは無料プランの非公開リポジトリでは効きません。
作れても守られないため、スクリプトが実際に効いているかを確かめ、効いていなければ警告します。
その場合はclassicのブランチ保護で「Allow deletions」を無効のままにするか、有料プランに上げてください。

`.github/workflows/branch-guard.yml`が、`main`や`develop`をheadにしたPull Requestで失敗します。
ただしこれは気付かせるだけで、マージは止めません。
必須チェックにするとGITHUB_TOKENが開いたPull Requestで埋まらなくなるためです。
削除そのものを止めるのはルールセットです。

既定ブランチは削除できません。
ただし自動削除の文書に既定ブランチの例外は書かれていないため、これを守りとして当てにしないでください。

### 消してしまったとき

マージ済みのPull Requestの画面に「Restore branch」が出ます。
これで戻ります。
復元できる期間は公式の文書に書かれていないため、気付いたらすぐ戻してください。

ボタンが存在しないときは、消える前の先端のSHAから作り直します。

```bash
gh pr view <番号> --json headRefOid --jq .headRefOid
gh api --method POST "repos/OWNER/REPO/git/refs" -f "ref=refs/heads/develop" -f "sha=<SHA>"
```

削除を禁止する規則をかけていると、作り直しも拒まれることがあります。
その場合は先に規則を一時的に無効にし、作り直したあとで戻します。

## そのほかの決まり

- ブランチの運用と文書の書き方は[CONTRIBUTING.md](CONTRIBUTING.md)にあります
- リリースの手順は[docs/repository-operations.md](docs/repository-operations.md)の「ブランチとリリース」にあります
- `scripts/setup.sh`と`scripts/setup.ps1`は同じことを行います。片方だけを変えないでください
- Pull Requestはマージコミット（Create a merge commit）でマージします
- 変更したら`npm run lint`を通します

## このサーバーの決まり

- stdioで動くとき、標準出力はMCPの通信路です。ログは`console.error`で標準エラーに出します。`console.log`を足すと通信が壊れます
- `.env`はコミットしません。`.gitignore`で外しています
- `src/tools/files.js`の防御を弱めないでください。変えたときは、許可ルートの外、`..`、8.3形式の短い名前、秘密のファイルが拒まれることを確かめます
- 本番のイメージは`npm ci --omit=dev`で作ります。サーバーが実行時に使うパッケージは`dependencies`に、文書の検査の道具は`devDependencies`に入れます
- サーバーを変えたら`npm test`を通します。Ollamaの代わりに`test/helpers/mock-ollama.js`を使うため、GPUは要りません。振る舞いを足したら試験も足します
- 試験の中でサーバーを起動するときは、作業ディレクトリを一時ディレクトリにします。手元の`.env`を読ませないためです
- 変えたあとは`docker compose up -d --build`で作り直し、`curl.exe http://127.0.0.1:3000/healthz`と、stdioの`initialize`の応答を確かめます
- HTTPでファイルを読めるのは、認証を設定したときだけです。この条件（`src/config/config.js`の`httpAllowFiles`）を外さないでください
- ツールの名前（`ollama_chat`など）は変えないでください。Claudeの側の許可（`mcp__ollama__*`）とサブエージェントの定義が名前を使っています
