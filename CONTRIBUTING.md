# 貢献の手引き

このリポジトリへの変更は、IssueとPull Requestで受け付けます。

## 進め方

1. 変更の前にIssueを立て、何を変えたいかを書きます。小さな修正はIssue無しでも構いません
1. `develop`から作業用のブランチを切ります（`feature/変更の名前`）
1. 変更を加え、`npm run lint`が通ることを確かめます
1. `develop`へのPull Requestを開きます。テンプレートに沿って、何をなぜ変えたかを書きます

## ブランチの運用

GitFlowに沿って運用します。

| ブランチ | 役割 |
| ---- | ---- |
| `main` | リリース済みの内容です。タグはここに打ちます |
| `develop` | 次のリリースに向けた開発の本流です |
| `feature/*` | 機能の追加や修正です。`develop`から切り、`develop`に戻します |
| `release/*` | リリースの準備です。「リリース」ワークフローが`develop`から切り、`main`に取り込みます |
| `hotfix/*` | リリース済みの内容の緊急の修正です。`main`から切り、そのブランチで`package.json`の版も上げます。`main`にマージすると公開され、`develop`にも戻されます |

リリースと緊急の修正の手順は[README](README.md)の「ブランチとリリース」にあります。
Pull Requestはマージコミット（Create a merge commit）でマージします。

`main`と`develop`は、Pull Requestのheadにしないでください。
マージ後にheadブランチが自動で消える設定のため、そのブランチごと失う恐れがあります。
`develop`から`main`へはリリースのワークフローが`release/*`ブランチを切ります。
`main`から`develop`へは`merge/*`ブランチを使います。
理由と直し方は[CLAUDE.md](CLAUDE.md)にあります。

## 文書の書き方

日本語の文書は`textlint`と`markdownlint`で検査します。
規則は公開されている共有設定[@223n/lint-config-ja](https://www.npmjs.com/package/@223n/lint-config-ja)にあります。

- 文体は「ですます調」で統一します
- 一文一行で書きます
- 全角文字と半角文字の間にスペースを入れません。半角の語はコードスパンに入れると読みやすくなります

手元で直せる指摘は`npm run lint:md:fix`と`npm run lint:ja:fix`で直ります。
直したあとは差分を見て、意図しない変更が無いかを確かめてください。

## スクリプトの書き方

`scripts/setup.sh`と`scripts/setup.ps1`は同じことを行います。
片方だけを変えないでください。
引数の書き方（`--dry-run`と`-DryRun`）が違います。
表示する文言と終了コードは揃えてください。
名前の書き換えは、`scripts/setup.sh`がNodeを、`scripts/setup.ps1`がPowerShellの文字列置換を使います。
そのため要る道具が違います。

- `scripts/setup.ps1`はPowerShell 7以上を前提にします。Windows PowerShell 5.1では動きません
- `.ps1`はBOM無しのUTF-8、改行はLFで保存します。PowerShell 7はBOMが無くてもUTF-8として読みます
- ネイティブコマンドの成否は`$LASTEXITCODE`で判定します。`if (gh ...)`は出力を見るため、`--silent`を付けた呼び出しでは常に偽になります
- `npm run lint`は日本語の文書だけを検査します。スクリプトは検査の対象外です

## コミットメッセージ

日本語で、何を変えたかと、なぜ変えたかを書きます。
1行目は50文字程度に収め、詳しい理由は空行を挟んで本文に書きます。

## ラベル

IssueとPull Requestのラベルは`.github/labels.yml`で管理します。
ラベルを足したり変えたりするときは、GitHubの画面ではなくこのファイルを変えてください。
`develop`に入ると同期のワークフローが動き、リポジトリのラベルがファイルの内容に揃います。
`main`側からの同期では、ファイルに無いラベルを消しません。
