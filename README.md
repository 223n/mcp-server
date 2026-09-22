# repo_template

リポジトリのテンプレートです。
日本語の文書の検査、日本語のラベル、Dependabot、GitFlowに沿ったリリースのワークフローが最初から入っています。

## 何が入っているか

| 位置 | 中身 |
| ---- | ---- |
| `.textlintrc.js`、`.markdownlint-cli2.jsonc` | 日本語の文書の検査設定です。規則は公開されている共有設定`@223n/lint-config-ja`にあります |
| `.textlintignore`、`.github/.markdownlint.jsonc` | 検査から外すものと、`.github/`配下だけに効く追加の規則です |
| `package.json` | 検査に使う道具の依存です。版もここで管理します |
| `.github/labels.yml` | IssueとPull Requestのラベルの定義です。すべて日本語です |
| `.github/labeler.yml` | Pull Requestに、変えたファイルやブランチ名からラベルを付ける規則です |
| `.github/dependabot.yml` | Dependabotの設定です。npmとGitHub Actionsを毎週まとめて更新します |
| `.github/release.yml` | GitHub Releaseの本文を自動で作るときの分類です |
| `.github/ISSUE_TEMPLATE/` | Issueのフォームです。バグ報告、機能の要望、質問の3つがあります |
| `.github/pull_request_template.md` | Pull Requestのテンプレートです |
| `.github/CODEOWNERS` | 変更の確認を求める相手です |
| `.github/workflows/` | CI、CodeQL、ラベルの同期、ラベル付け、headブランチの確認、リリースのワークフローです |
| `scripts/setup.sh`、`scripts/setup.ps1` | テンプレートから作った直後の設定をまとめて行うスクリプトです。`gh`を使います。中身は同じで、`.ps1`はWindows向けです |
| `CONTRIBUTING.md` | 貢献の手引きです。ブランチの運用と文書の書き方があります |
| `CLAUDE.md` | Claude Codeが読む決まりです。ブランチを消さないための注意があります |
| `SECURITY.md` | 脆弱性の報告先です |

## テンプレートから作る

1. GitHubでこのリポジトリを開き、「Use this template」から「Create a new repository」を選びます
1. 「Include all branches」にはチェックを入れません
1. 作ったリポジトリで、次の「作った直後にやること」を順に行います

「Include all branches」でブランチを複製すると、複製したブランチどうしが共通の祖先を持たない状態になります。
テンプレートから作ったリポジトリは、ブランチごとに独立した最初のコミットから始まるためです。
この状態では`main`と`develop`の間でPull Requestを作れず、リリースのワークフローも`merge`で止まります。
`develop`は次の手順でスクリプトが`main`から作るため、チェックを入れる必要はありません。
すでにチェックを入れて作ってしまった場合は、後の「履歴が繋がっていないとき」を見てください。

### 要るもの

セットアップのスクリプトを実行する前に、次をそろえます。

| 要るもの | 何に使うか |
| ---- | ---- |
| リポジトリの管理者権限 | スクリプトが変える設定は、どれも管理者権限が要ります |
| `gh`（GitHub CLI）とログイン | 設定の変更とPull Requestの作成に使います。先に`gh auth login`を済ませます |
| `git`の`user.name`と`user.email` | スクリプトが名前の書き換えをコミットします |
| Node 22以上 | 文書の検査（`npm run lint`）に使います。`scripts/setup.sh`は名前の書き換えにも使います |
| PowerShell 7以上 | Windowsで`scripts/setup.ps1`を使う場合です。Windows PowerShell 5.1では動きません |

`scripts/setup.ps1`は、名前の書き換えにNodeを使いません。

スクリプトはcloneのルートで実行します。
次の場合は、名前の書き換えと履歴の確認が飛ばされます。
飛ばした項目は実行の最後に一覧で出るため、直してから実行し直せます。

- cloneの外や、サブディレクトリで実行した
- `--repo OWNER/REPO`で、いまいるcloneとは別のリポジトリを指定した
- 作業木に未コミットの変更がある
- 浅いclone（`--depth`付き）を使っている

### 作った直後にやること

`gh`（GitHub CLI）にログインしたうえで、cloneの中で次を実行します。

```bash
scripts/setup.sh                        # 設定をまとめて行う
scripts/setup.sh --runs-on self-hosted  # セルフホストのランナーも設定する
scripts/setup.sh --dry-run              # 何をするかを表示するだけ
```

WindowsではPowerShell 7以上で`scripts/setup.ps1`を使います。
行うことは`scripts/setup.sh`と同じで、引数の書き方が違います。

```powershell
.\scripts\setup.ps1                      # 設定をまとめて行う
.\scripts\setup.ps1 -RunsOn self-hosted  # セルフホストのランナーも設定する
.\scripts\setup.ps1 -DryRun              # 何をするかを表示するだけ
```

`Get-Help .\scripts\setup.ps1 -Detailed`で引数の説明が読めます。
実行が「このシステムではスクリプトの実行が無効になっている」と拒まれる場合は、`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`を実行してから使います。

スクリプトは次を行います。
何度実行しても結果は同じで、失敗した項目は最後にまとめて表示します。

- `develop`ブランチが無ければ`main`から作ります
- `develop`ブランチがすでにある場合は、`main`と共通の祖先があるかを確かめます。無ければ警告します
- 「Allow GitHub Actions to create and approve pull requests」を有効にします。リリースのワークフローがPull Requestを開くために要ります
- squash mergeとrebase mergeを無効にし、マージ後にブランチを消す設定にします
- 「ブランチの削除を禁止する」ルールセットを作り、`main`と`develop`が消えないようにします。効いているかも確かめます
- Private vulnerability reporting、Dependabot alerts、Dependabot security updatesを有効にします
- 「ラベルを同期する」ワークフローを起動します。既定の英語のラベルが日本語に置き換わります
- `.github/CODEOWNERS`、`.github/ISSUE_TEMPLATE/config.yml`のURL、`package.json`の`name`をこのリポジトリのものに書き換え、`develop`へのPull Requestを開きます

スクリプトを実行したら、残りは次の「必要な設定」と「自分で書き換えるファイル」を見てください。

実行のあと、手元は`feature/setup-repository`ブランチに残ります。
開かれたPull Requestをマージしたら、`develop`に戻してから作業を始めます。

### 必要な設定

GitHubの画面で行う設定です。
「スクリプト」が「行う」のものは、セットアップのスクリプトが代わりに設定します。

| 設定 | 場所 | スクリプト |
| ---- | ---- | ---- |
| ActionsにPull Requestの作成と承認を許す | 「Settings」→「Actions」→「General」→「Workflow permissions」 | 行う |
| マージコミットだけを許し、マージ後にブランチを消す | 「Settings」→「General」→「Pull Requests」 | 行う |
| Private vulnerability reporting | 「Settings」→「Advanced Security」 | 行う |
| Dependabot alerts、Dependabot security updates | 「Settings」→「Advanced Security」 | 行う |
| Code scanningのDefault setupを使わない | 「Settings」→「Advanced Security」 | 行わない |
| `main`と`develop`の削除を禁止する | 「Settings」→「Rules」 | 行う |
| `main`と`develop`のそのほかのブランチ保護（任意） | 「Settings」→「Rules」 | 行わない |
| 変数`RUNS_ON`（セルフホストのランナーを使う場合） | 「Settings」→「Secrets and variables」→「Actions」→「Variables」 | `--runs-on`で行う |
| このリポジトリ自身をテンプレートにする | 「Settings」→「General」→「Template repository」 | `--template`で行う |

次は組織の管理者に頼みます。
どれも、リポジトリ側では変えられません。

- 組織の「Settings」→「Actions」→「General」で、ActionsによるPull Requestの作成を許可します
- 組織で使えるアクションを制限している場合は、`.github/workflows/`が使うアクションを許可リストに入れてもらいます
- 組織のセキュリティ設定が強制（enforced）で当たっている場合は、そちらを緩めてもらいます
- 非公開リポジトリでCodeQLの結果を出すには、GitHub Code Securityのライセンスが要ります

設定するときの注意です。

- Private vulnerability reportingは公開リポジトリの機能です。非公開リポジトリでは有効にできず、Issueの選択画面の「脆弱性の報告」リンクも働きません
- Code scanningのDefault setupは使いません。走査は`codeql.yml`が行います。誤って有効にしたときは、同じ画面で無効に戻します
- 「Require code scanning results」の規則は、`codeql.yml`の結果（ツール名はCodeQL）で満たせます。ただし解析中とツールが未設定のときもマージを止めます
- `develop`にPull Requestを必須にする規則をかけると、リリース後の戻しは毎回Pull Requestになります
- ルールセットは無料プランの非公開リポジトリでは効きません。作れても守られないため、スクリプトが確かめて警告します
- 「ブランチの削除を禁止する」ルールセットがあると、`develop`を消して作り直す復旧ができません。後の「履歴が繋がっていないとき」を見てください

### 自分で書き換えるファイル

テンプレート由来の値が残っているファイルです。
「スクリプト」が「行う」のものは、セットアップのスクリプトが書き換えて`develop`へのPull Requestを開きます。

| ファイル | 書き換えるところ | スクリプト |
| ---- | ---- | ---- |
| `.github/CODEOWNERS` | 変更の確認を求める相手 | 行う |
| `.github/ISSUE_TEMPLATE/config.yml` | 脆弱性の報告先のURL | 行う |
| `package.json` | `name` | 行う |
| `package.json` | `description`と`version` | 行わない |
| `package.json` | `private: true`。npmに公開するなら外します | 行わない |
| `README.md` | このファイル全体 | 行わない |
| `SECURITY.md` | 非公開で連絡できる先 | 行わない |
| `LICENSE` | `Copyright [yyyy] [name of copyright owner]`の行 | 行わない |
| `LICENSE`と`package.json`の`license` | ライセンスを変える場合 | 行わない |

`version`はテンプレートの`0.2.0`から始まります。
最初のリリースは`0.2.0`より大きい版だけが通ります。
もっと小さい版から始めるなら、`main`と`develop`の両方で先に`version`を下げます。

## 使ううえでの注意

作る前に知っておくと、あとで困らないものです。

| 場面 | 何が起きるか | どうするか |
| ---- | ---- | ---- |
| ブランチ名 | `release/`、`hotfix/`、`merge/`で始めると、リリースの仕組みが反応します | 作業ブランチには`feature/`を使います |
| Pull Requestのhead | `main`や`develop`をheadにすると、「PRのheadブランチを確かめる」が失敗します | リリースはワークフローに任せます。詳しくは[CLAUDE.md](CLAUDE.md)にあります |
| マージの方法 | squashやrebaseだと、リリースノートにPull Requestが載らず、次の版で衝突します | マージコミット（Create a merge commit）でマージします |
| ラベル | 同期が済むまで、IssueフォームとDependabotが指定するラベルは黙って付きません | 最初のPull Requestを開く前にセットアップを済ませます |
| `.github/CODEOWNERS` | Pull Requestのbaseブランチのものが読まれ、`main`には最初のリリースまで届きません | `main`向けのPull Requestで確認者が付かなくても、設定漏れではありません |
| Issueのフォーム | 既定ブランチ（`main`）に入るまで、画面に反映されません | 同じく、`main`に入るまで待ちます |
| セルフホストのランナー | `RUNS_ON`のラベルに一致するランナーが無いと、失敗せずに待機のまま止まります | 設定したらCIを手で1回動かして確かめます |
| 改行コード | `.gitattributes`が全ファイルをLFに固定します | CRLFのファイルを持ち込むと、最初のコミットで全行が差分になります |

リリースやCIが途中で止まったときは、ワークフローのログに日本語で対処方法が出ます。
`main`と`develop`に共通の祖先が無い場合だけ、後の「履歴が繋がっていないとき」を見てください。

## 日本語の文書を検査する

Markdownの書式を`markdownlint`で、日本語の書き方を`textlint`で検査します。
規則は公開されている共有設定[@223n/lint-config-ja](https://www.npmjs.com/package/@223n/lint-config-ja)にあり、このリポジトリには「何を検査するか」だけを書いてあります。
規則の理由は[node_japanese_lint_template](https://github.com/223n/node_japanese_lint_template)にあります。

```bash
npm install
npm run lint          # 書式と日本語をまとめて検査する
npm run lint:md:fix   # 書式の指摘を直す
npm run lint:ja:fix   # 日本語の指摘のうち、機械的に直せるものを直す
```

Node 22以上が要ります。

文体は「ですます調」です。
「である調」にしたい場合や、規則を一部だけ変えたい場合は、`.textlintrc.js`のコメントに書き方があります。

`main`と`develop`への`push`と、すべてのPull Requestで、CIが同じ検査をします。
CIではあわせて、ワークフローの構文を`actionlint`で、安全性を`zizmor`で検査します。
ワークフローの安全性は、`codeql.yml`もCodeQLの`actions`言語で走査します。
ワークフローが開いたPull Request（リリースのPull Requestなど）では、CIは「承認待ち」で作られます。
書き込み権限のある人が「Approve workflows to run」を押すと動きます。
承認せずにマージすると、承認待ちの実行は失敗として記録されますが、検査が落ちたわけではありません。

## ラベル

IssueとPull Requestのラベルはすべて日本語です。
`.github/labels.yml`が定義で、「ラベルを同期する」ワークフローがリポジトリのラベルをこの内容に揃えます。
ラベルを足したり変えたりするときは、GitHubの画面ではなくこのファイルを変えてください。
ファイルに無いラベルは消えます。
ただし`main`からの同期では消しません。
`main`の`.github/labels.yml`が`develop`より古い期間に、`develop`で足したラベルを消さないためです。

| ラベル | 用途 | 誰が付けるか |
| ---- | ---- | ---- |
| バグ | 期待どおりに動かない | Issueフォーム |
| 機能追加 | 新しい機能や改善の要望 | Issueフォーム |
| ドキュメント | 文書の追加や修正 | ラベラー、人 |
| 質問 | 使い方や仕様についての質問 | Issueフォーム |
| アクセシビリティ | 障害のある人の利用を妨げるもの | 人 |
| 重複 | すでにあるIssueやPull Requestと同じ内容 | 人 |
| 無効 | 内容が正しくない、または対象外 | 人 |
| 対応しない | 対応しないと判断したもの | 人 |
| 初心者向け | はじめて貢献する人に向く課題 | 人 |
| 助けが必要 | 手を貸してほしい課題 | 人 |
| 依存関係 | 依存パッケージやアクションの更新 | Dependabot、ラベラー |
| npm | npmパッケージの更新 | Dependabot |
| GitHub Actions | GitHub Actionsの更新 | Dependabot、ラベラー |
| リリース | リリースの準備と公開 | リリースのワークフロー |
| セキュリティ | 脆弱性やセキュリティに関わる修正 | 人、ラベラー |
| 破壊的変更 | 後方互換性を壊す変更 | 人 |

GitHubが最初から用意する英語のラベル（`bug`や`enhancement`など）は、付いているIssueを保ったまま日本語のラベルに改名されます。
Dependabotが作る既定のラベル（`dependencies`、`javascript`、`github_actions`）も同じように改名されます。
対応は`.github/labels.yml`の`from_name`にあります。

「初心者向け」と「助けが必要」は、GitHubの「Contribute」ページが英語名の`good first issue`と`help wanted`で判定するため、改名するとそこには載らなくなります。
その機能を使うなら、この2つは英語名のまま残してください。

Pull Requestには、変えたファイルとブランチ名から`.github/labeler.yml`の規則でラベルが自動で付きます。

## Dependabot

`.github/dependabot.yml`で、npmの依存とGitHub Actionsのアクションを毎週月曜の朝に確かめます。
Pull Requestは`develop`に向けて開かれ、「依存関係」と「npm」または「GitHub Actions」のラベルが付きます。
npmではminorとpatchの更新が本番用と開発用の2つのPull Requestにまとまり、majorの更新は個別に開かれます。
GitHub Actionsのアクションは、majorも含めてすべて1つのPull Requestにまとまります。

ワークフローが使うアクションはコミットSHAで固定し、版はコメントに書いてあります。
DependabotはSHAとコメントの両方を更新します。

セキュリティ更新は常に既定ブランチ（`main`）に向けて開かれます。
既定ブランチ向けのエントリも書いてあるため、そこにも同じラベルと接頭辞が付きます。
このエントリは版の更新を開かない設定（`open-pull-requests-limit: 0`）です。
不要に見えても消さないでください。消すとセキュリティ更新からラベルと接頭辞が無くなります。

`develop`をやめて`main`だけで運用する場合は、`.github/dependabot.yml`の`target-branch`を消してください。
`develop`が無いまま残っていると、版の更新が一切来なくなります。

## ブランチとリリース

GitFlowに沿って運用します。
ブランチの役割は[CONTRIBUTING.md](CONTRIBUTING.md)にあります。

```text
develop ──▶ release/vX.Y.Z ──(Pull Request)──▶ main ──▶ タグ vX.Y.Z と GitHub Release ──▶ develop へ戻す
```

### リリースする

1. Actionsの「リリース」を開き、「Run workflow」を選びます
1. `version`にリリースする版を入れます。`v`は付けません（例: `1.2.0`、`1.2.0-rc.1`）
1. ワークフローが`develop`から`release/vX.Y.Z`ブランチを切り、`package.json`の版を上げ、`main`へのPull Requestを開きます
1. Pull Requestの内容を確かめ、マージコミット（Create a merge commit）でマージします
1. 「リリースを公開する」ワークフローが動き、タグ`vX.Y.Z`を打ち、GitHub Releaseを作り、`main`を`develop`に戻します

版は`package.json`の`version`で管理します。
`develop`と`main`の版、最新のタグのどれよりも大きい版だけを受け付けます。
すでにあるタグや、開いたままの`release/*`ブランチがあると止まります。
`-rc.1`のようなプレリリースの版は、GitHub Releaseでもプレリリースになります。

`auto_merge`を有効にして実行すると、Pull Requestを人手で確かめずにマージし、公開まで一気に進めます。
ただし`main`に必須のチェックや承認のルールがあると、マージで止まります。
ワークフローが開いたPull RequestのCIは承認待ちのままで、ルールを満たせないためです。
その場合は人がPull Requestをマージすれば、公開のワークフローが続きを行います。

`develop`にPull Requestを必須にする規則がある場合、`main`から`develop`への戻しは毎回Pull Requestになります。
ブランチ名は`merge/vX.Y.Z-into-develop`です。
リリースのあとに、このPull Requestもマージコミットでマージしてください。

マージコミットでマージする理由は「使ううえでの注意」にあります。

GitHub Releaseの本文は、マージしたPull Requestのタイトルとラベルから自動で作られます。
分類は`.github/release.yml`にあります。

### 緊急の修正（hotfix）

リリース済みの内容を急いで直すときは、`main`から`hotfix/名前`ブランチを切ります。
そのブランチで修正し、`package.json`の版も上げます。

```bash
npm version patch --no-git-tag-version
```

`main`へのPull Requestをマージコミットでマージすると、「リリースを公開する」ワークフローが`release/*`と同じように動きます。
版を上げ忘れると、同じ版のタグがすでにあるため止まります。

## GitHub Actionsのランナー

ワークフローは既定でGitHubがホストする`ubuntu-latest`で動きます。
セルフホストのランナーがある場合は、リポジトリまたは組織の変数`RUNS_ON`に、ランナーのラベル（例: `self-hosted`）を設定します。
設定は「Settings」→「Secrets and variables」→「Actions」の「Variables」にあります。
`scripts/setup.sh --runs-on ラベル`でも行えます。
Windowsでは`.\scripts\setup.ps1 -RunsOn ラベル`です。
変数が無いときは`ubuntu-latest`に倒れるため、設定しなくても動きます。

セルフホストのランナーには、`git`と`gh`（GitHub CLI）、Dockerが要ります。
Dockerはzizmorの検査（コンテナで動きます）に使います。
Nodeはワークフローが用意します。
公開リポジトリでセルフホストのランナーを使うと、フォークからのPull Requestで任意のコードが動くため、非公開のリポジトリで使ってください。

## ワークフローの一覧

| ファイル | いつ動くか | 何をするか |
| ---- | ---- | ---- |
| `ci.yml` | `main`と`develop`への`push`、Pull Request、手動 | 日本語の文書、ワークフローの構文（actionlint）、ワークフローの安全性（zizmor）を検査します |
| `codeql.yml` | `main`と`develop`への`push`、Pull Request、毎週月曜、手動 | ワークフローの安全性をCodeQLで走査します。結果は「Security」→「Code scanning」に出ます |
| `labels.yml` | `.github/labels.yml`か`.github/workflows/labels.yml`の変更、手動 | リポジトリのラベルを定義に揃えます。Pull Requestでは差分の表示だけです |
| `labeler.yml` | Pull Requestを開いたとき、更新したとき | 変えたファイルとブランチ名からラベルを付けます |
| `branch-guard.yml` | Pull Requestを開いたとき、更新したとき | headブランチが`main`か`develop`なら失敗します。マージは止めません |
| `release.yml` | 手動 | `develop`からリリースブランチを切り、版を上げ、`main`へのPull Requestを開きます |
| `release-publish.yml` | `release/*`か`hotfix/*`のPull Requestが`main`にマージされたとき | タグを打ち、GitHub Releaseを作り、`main`を`develop`に戻します |

## 履歴が繋がっていないとき

「Include all branches」にチェックを入れて作ったリポジトリでは、`main`と`develop`が共通の祖先を持ちません。
セットアップのスクリプトはこれを見つけると、次のように警告します。

```text
  ! main と develop の履歴が繋がっていない（共通の祖先が無い）
```

放っておくと、リリースのワークフローが`main`を取り込むところで止まります。
`main`から`develop`への戻しもできず、版が`develop`に届かなくなります。

直し方は2つあります。
どちらを選ぶかは、`develop`に残したい変更があるかどうかで決まります。

`develop`に残したい変更が無い場合は、`develop`を消してからスクリプトを実行し直します。
スクリプトが`main`から`develop`を作り直すため、履歴が繋がります。
Windowsでは`scripts/setup.sh`のところを`.\scripts\setup.ps1`に読み替えてください。

```bash
gh api --method DELETE "repos/OWNER/REPO/git/refs/heads/develop"
scripts/setup.sh
```

「ブランチの削除を禁止する」ルールセットがあると、この削除は拒まれます。
「Settings」→「Rules」でそのルールセットの「Enforcement」を「Disabled」にし、作り直したあとで「Active」に戻します。

`develop`にすでに作業がある場合は、`main`を`--allow-unrelated-histories`付きで取り込みます。
共通の祖先ができるため、以後は普通に行き来できます。

```bash
git switch develop
git merge --allow-unrelated-histories origin/main
git push origin develop
```

こちらには副作用が2つあります。
共通の祖先が無いため、`main`にしかないファイルは削除ではなく追加として扱われ、`develop`に現れます。
履歴にも、2つの根を繋ぐマージコミットが残ります。

どちらの方法でも、`develop`から切った作業ブランチと、`develop`に向けて開いているPull Requestの扱いは確かめてください。
`develop`を作り直した場合、それらは繋がらなくなります。

## ライセンス

Apache License 2.0です。
[LICENSE](LICENSE)を見てください。
