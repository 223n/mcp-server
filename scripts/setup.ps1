#Requires -Version 7.0

<#
.SYNOPSIS
テンプレートから作ったリポジトリの初期設定をまとめて行う。scripts/setup.sh の PowerShell 版である。

.DESCRIPTION
README の「作った直後にやること」のうち、gh CLI で行えるものを自動化する。
何度実行しても同じ結果になるように書いてあり、途中で失敗した項目は最後にまとめて出す。

scripts/setup.sh と同じことを行う。片方だけを変えないこと。
違いは、名前の書き換えに Node を使わず PowerShell の文字列置換を使う点だけである。

前提: gh CLI が入っていて、gh auth login が済んでいること。リポジトリの管理者権限が要る。
      PowerShell 7 以上で動かすこと。Windows PowerShell 5.1 では動かない。

.PARAMETER Repo
対象のリポジトリを OWNER/REPO で指定する。省略すると、いまいるディレクトリのリポジトリを使う。

.PARAMETER RunsOn
セルフホストのランナーを使うとき、変数 RUNS_ON に設定するラベル（例: self-hosted）。

.PARAMETER Template
このリポジトリ自身をテンプレートとして使えるようにする。

.PARAMETER NoPr
ファイルの書き換えをコミットせず、作業木に残す。

.PARAMETER DryRun
実行せず、何をするかを表示する。

.EXAMPLE
scripts\setup.ps1

.EXAMPLE
scripts\setup.ps1 -RunsOn self-hosted

.EXAMPLE
scripts\setup.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Repo = '',
    [string]$RunsOn = '',
    [switch]$Template,
    [switch]$NoPr,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 日本語が化けないようにする。リダイレクト先によっては変えられないため、失敗しても進む
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch {
    Write-Verbose "出力の文字コードを UTF-8 にできなかった: $_"
}

$DevelopBranch = 'develop'
$MainBranch = 'main'
$RulesetName = 'ブランチの削除を禁止する'
$TemplateOwner = '223n'
$TemplateRepo = '223n/repo_template'
$TemplatePackageName = 'repo-template'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$failures = [System.Collections.Generic.List[string]]::new()
function Write-Info { param([string]$Message) Write-Host "▶ $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "  ✓ $Message" }
function Write-Warn {
    param([string]$Message)
    $failures.Add($Message)
    [Console]::Error.WriteLine("  ! $Message")
}

# コマンドを実行し、成功したかを返す。-DryRun のときは表示だけにする。
# ネイティブコマンドの出力は Out-Host へ流す。戻り値の真偽値と混ざらないようにするためである
function Invoke-Step {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    if ($DryRun) {
        Write-Host "  + $FilePath $($ArgumentList -join ' ')"
        return $true
    }
    & $FilePath @ArgumentList | Out-Host
    return ($LASTEXITCODE -eq 0)
}

# gh を静かに実行し、成功したかだけを返す
function Test-Gh {
    param([Parameter(Mandatory)][string[]]$ArgumentList)
    & gh @ArgumentList *> $null
    return ($LASTEXITCODE -eq 0)
}

# gh の出力を1行だけ取る。失敗したときは $null を返す
function Get-GhValue {
    param([Parameter(Mandatory)][string[]]$ArgumentList)
    $output = & gh @ArgumentList 2> $null
    if ($LASTEXITCODE -ne 0) { return $null }
    if (-not $output) { return $null }
    return ([string[]]$output)[0].Trim()
}

# ---- 前提を確かめる
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('gh（GitHub CLI）が見つかりません。https://cli.github.com/ から入れてください。')
    exit 1
}
if (-not (Test-Gh @('auth', 'status'))) {
    [Console]::Error.WriteLine('gh にログインしていません。gh auth login を実行してください。')
    exit 1
}
if (-not $Repo) {
    $Repo = Get-GhValue @('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
    if (-not $Repo) {
        [Console]::Error.WriteLine('対象のリポジトリが分かりません。リポジトリの中で実行するか、-Repo OWNER/REPO を付けてください。')
        exit 1
    }
}
$owner, $name = $Repo -split '/', 2
$defaultBranch = Get-GhValue @('repo', 'view', $Repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name')
if (-not $defaultBranch) {
    [Console]::Error.WriteLine("既定ブランチを取れませんでした: $Repo")
    exit 1
}

# いまいるディレクトリが対象リポジトリの clone かどうか。
# ローカルの git を使う確認（履歴が繋がっているか）に要る
$inClone = $false
if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Gh @('repo', 'view', '--json', 'nameWithOwner'))) {
    git rev-parse --git-dir *> $null
    if ($LASTEXITCODE -eq 0) {
        $inClone = (Get-GhValue @('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')) -eq $Repo
    }
}

Write-Info "対象: ${Repo}（既定ブランチ: ${defaultBranch}）"
if ($DryRun) { Write-Host '  -DryRun のため、実際には何も変えません' }

# ---- 1. マージの方法とブランチの自動削除
Write-Info 'マージはマージコミットだけにし、マージ後にブランチを消す'
$editArgs = @(
    'repo', 'edit', $Repo,
    '--enable-merge-commit',
    '--enable-squash-merge=false',
    '--enable-rebase-merge=false',
    '--delete-branch-on-merge'
)
if ($Template) { $editArgs += '--template' }
if (Invoke-Step 'gh' $editArgs) {
    Write-Ok '設定した'
} else {
    Write-Warn 'リポジトリの設定を変えられなかった（gh repo edit）'
}

# ---- 2. Actions が PR を開けるようにする
Write-Info 'Actions に Pull Request の作成と承認を許す（リリースのワークフローが使う）'
$permArgs = @(
    'api', '--method', 'PUT', "repos/${Repo}/actions/permissions/workflow",
    '-f', 'default_workflow_permissions=read',
    '-F', 'can_approve_pull_request_reviews=true',
    '--silent'
)
if (Invoke-Step 'gh' $permArgs) {
    Write-Ok '許可した'
} else {
    Write-Warn 'Actions の許可を変えられなかった。組織の設定で禁止されているときは、先に組織の Settings > Actions > General で許可する'
}

# ---- 3. セキュリティ機能
Write-Info 'Private vulnerability reporting を有効にする（SECURITY.md と Issue の選択画面が使う）'
if (Invoke-Step 'gh' @('api', '--method', 'PUT', "repos/${Repo}/private-vulnerability-reporting", '--silent')) {
    Write-Ok '有効にした'
} else {
    Write-Warn 'Private vulnerability reporting を有効にできなかった。組織で一括管理されているか、権限が足りない'
}

Write-Info 'Dependabot alerts と security updates を有効にする'
if (Invoke-Step 'gh' @('api', '--method', 'PUT', "repos/${Repo}/vulnerability-alerts", '--silent')) {
    Write-Ok 'Dependabot alerts を有効にした'
} else {
    Write-Warn 'Dependabot alerts を有効にできなかった'
}
if (Invoke-Step 'gh' @('api', '--method', 'PUT', "repos/${Repo}/automated-security-fixes", '--silent')) {
    Write-Ok 'Dependabot security updates を有効にした'
} else {
    Write-Warn 'Dependabot security updates を有効にできなかった'
}

# ---- 4. develop ブランチ
Write-Info "${DevelopBranch} ブランチを用意する"
if (Test-Gh @('api', "repos/${Repo}/branches/${DevelopBranch}", '--silent')) {
    Write-Ok 'すでにある'

    # 「Include all branches」で複製した develop は、既定ブランチと共通の祖先を持たない。
    # GitHub の仕様で、テンプレートから作ったブランチはそれぞれ独立した最初のコミットから始まるためである。
    # この状態だとリリースのワークフローが merge で止まるため、ここで気付けるようにする。
    # 判定はローカルの git で行う。fetch はリモート追跡の参照を更新するだけなので -DryRun でも実行する
    if (-not $inClone) {
        Write-Warn "clone の外で実行しているため、${defaultBranch} と ${DevelopBranch} が繋がっているかを確かめられなかった。clone の中で再実行する"
    } else {
        $shallow = (git rev-parse --is-shallow-repository 2> $null | Select-Object -First 1)
        if ($shallow -eq 'true') {
            Write-Warn "浅い clone のため、${defaultBranch} と ${DevelopBranch} が繋がっているかを確かめられなかった。git fetch --unshallow してから再実行する"
        } else {
            git fetch --quiet origin `
                "+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}" `
                "+refs/heads/${DevelopBranch}:refs/remotes/origin/${DevelopBranch}" *> $null
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "git fetch できず、${defaultBranch} と ${DevelopBranch} が繋がっているかを確かめられなかった"
            } else {
                git merge-base "origin/${defaultBranch}" "origin/${DevelopBranch}" *> $null
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "${defaultBranch} と共通の祖先がある"
                } else {
                    Write-Warn "${defaultBranch} と ${DevelopBranch} の履歴が繋がっていない（共通の祖先が無い）"
                    [Console]::Error.WriteLine(@"
    このままではリリースのワークフローが merge で止まり、${defaultBranch} と ${DevelopBranch} を行き来できない。
    ${DevelopBranch} に残したい変更が無ければ、${DevelopBranch} を消してからこのスクリプトを実行し直す。
      gh api --method DELETE "repos/${Repo}/git/refs/heads/${DevelopBranch}"
    「${RulesetName}」の規則がかかっていると、この削除は拒まれる。
    先に Settings > Rules でその規則の Enforcement を Disabled にし、作り直したあとで Active に戻す。
    詳しくは README の「履歴が繋がっていないとき」を読む。
"@)
                }
            }
        }
    }
} else {
    $sha = Get-GhValue @('api', "repos/${Repo}/git/ref/heads/${defaultBranch}", '--jq', '.object.sha')
    if (-not $sha) {
        Write-Warn "${defaultBranch} の先端が取れず、${DevelopBranch} ブランチを作れなかった"
    } elseif (Invoke-Step 'gh' @('api', '--method', 'POST', "repos/${Repo}/git/refs", '-f', "ref=refs/heads/${DevelopBranch}", '-f', "sha=${sha}", '--silent')) {
        Write-Ok "${defaultBranch}（$($sha.Substring(0, 7))）から作った"
    } else {
        Write-Warn "${DevelopBranch} ブランチを作れなかった"
    }
}

# ---- 5. main と develop の削除を禁止する
# 「Automatically delete head branches」を有効にしているため、main や develop を head にした
# Pull Request をマージすると、そのブランチごと消える。削除を禁止する規則で止める。
# 無料プランの非公開リポジトリでは規則を作れても効かないため、あとで効いているかを確かめる
Write-Info "${MainBranch} と ${DevelopBranch} の削除を禁止する規則を作る"
$rulesetFailed = $false
$rulesetId = Get-GhValue @(
    'api', "repos/${Repo}/rulesets?includes_parents=false",
    '--jq', "[.[] | select(.name == `"${RulesetName}`")] | first | .id // empty"
)
if ($rulesetId) {
    # 利用者が同じ規則に別のルールを足していることがあるため、中身は変えない
    Write-Ok "すでにある（id: ${rulesetId}）。中身は変えない"
} else {
    $rulesetBody = @"
{
  "name": "${RulesetName}",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/${MainBranch}", "refs/heads/${DevelopBranch}"], "exclude": [] } },
  "rules": [ { "type": "deletion" } ]
}
"@
    if ($DryRun) {
        Write-Host "  + gh api --method POST repos/${Repo}/rulesets --input -"
        foreach ($line in $rulesetBody -split "`n") { Write-Host "    $line" }
    } else {
        # Invoke-Step は標準入力を渡せないため、BOM 無しの UTF-8 で一時ファイルに書いて渡す
        $bodyFile = [System.IO.Path]::GetTempFileName()
        try {
            [System.IO.File]::WriteAllText($bodyFile, $rulesetBody, $Utf8NoBom)
            gh api --method POST "repos/${Repo}/rulesets" --input $bodyFile --silent
            if ($LASTEXITCODE -eq 0) {
                Write-Ok '作った'
            } else {
                Write-Warn '削除を禁止する規則を作れなかった。無料プランの非公開リポジトリでは使えない。組織で一括管理されているか、権限が足りない場合もある'
                $rulesetFailed = $true
            }
        } finally {
            Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# 作れても効いていないことがある。実際に効いている規則だけを返す API で確かめる
if (-not $DryRun) {
    $unguarded = @()
    foreach ($branch in @($MainBranch, $DevelopBranch)) {
        $guarded = Get-GhValue @('api', "repos/${Repo}/rules/branches/${branch}", '--jq', 'any(.[]; .type == "deletion")')
        if ($guarded -ne 'true') { $unguarded += $branch }
    }
    if ($unguarded.Count -eq 0) {
        Write-Ok "${MainBranch} と ${DevelopBranch} の削除は禁止されている"
    } elseif (-not $rulesetFailed) {
        Write-Warn "$($unguarded -join '、') の削除を禁止できていない。無料プランの非公開リポジトリでは規則が効かない。classic のブランチ保護は見ていないため、そちらでかけている場合はこの警告を無視してよい"
    }
}

# ---- 6. セルフホストのランナー
if ($RunsOn) {
    Write-Info "変数 RUNS_ON を ${RunsOn} にする"
    if (Invoke-Step 'gh' @('variable', 'set', 'RUNS_ON', '--body', $RunsOn, '--repo', $Repo)) {
        Write-Ok '設定した'
    } else {
        Write-Warn '変数 RUNS_ON を設定できなかった'
    }
}

# ---- 7. ラベルを揃える
Write-Info '「ラベルを同期する」ワークフローを動かす（既定の英語ラベルが日本語に置き換わる）'
if (Invoke-Step 'gh' @('workflow', 'run', 'labels.yml', '--repo', $Repo, '--ref', $DevelopBranch)) {
    Write-Ok '起動した。結果は Actions の画面で確かめる'
} else {
    Write-Warn 'ラベル同期を起動できなかった。Actions の画面から「ラベルを同期する」を手で実行する'
}

# ---- 8. テンプレート由来の名前を書き換える
Write-Info 'テンプレート由来の名前を、このリポジトリのものに書き換える'
$changed = [System.Collections.Generic.List[string]]::new()

# ファイルの中の文字列を置き換える。置き換えたら $true を返す
function Update-Name {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$From,
        [Parameter(Mandatory)][string]$To
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $full = Convert-Path -LiteralPath $Path
    $text = [System.IO.File]::ReadAllText($full)
    if (-not $text.Contains($From)) { return $false }
    if ($DryRun) {
        Write-Host "  + ${Path}: $From → $To"
        return $false
    }
    [System.IO.File]::WriteAllText($full, $text.Replace($From, $To), $Utf8NoBom)
    return $true
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Warn 'git が見つからないため、名前の書き換えは飛ばした。git を入れて再実行する'
} elseif ((Test-Path -LiteralPath '.git') -and (Test-Path -LiteralPath 'package.json' -PathType Leaf)) {
    # 作業木がきれいなことを確かめる。書き換えを他の変更と混ぜない
    $status = git status --porcelain
    if ($status) {
        Write-Warn '作業木に未コミットの変更があるため、名前の書き換えは飛ばした。コミットしてから再実行する'
    } else {
        if ($Repo -ne $TemplateRepo) {
            if (Update-Name '.github/CODEOWNERS' "@${TemplateOwner}" "@${owner}") { $changed.Add('.github/CODEOWNERS') }
            if (Update-Name '.github/ISSUE_TEMPLATE/config.yml' $TemplateRepo $Repo) { $changed.Add('.github/ISSUE_TEMPLATE/config.yml') }
            # npm のパッケージ名は小文字に限る
            if (Update-Name 'package.json' "`"name`": `"${TemplatePackageName}`"" "`"name`": `"$($name.ToLowerInvariant())`"") { $changed.Add('package.json') }
        }
        if ($changed.Count -eq 0) {
            Write-Ok '書き換えるものは無い'
        } elseif (-not $NoPr) {
            $branch = 'feature/setup-repository'
            Invoke-Step 'git' @('switch', '--create', $branch) | Out-Null
            Invoke-Step 'git' (@('add') + $changed) | Out-Null
            Invoke-Step 'git' @('commit', '--quiet', '--message', 'テンプレート由来の名前をこのリポジトリのものに書き換える') | Out-Null
            Invoke-Step 'git' @('push', '--set-upstream', 'origin', $branch) | Out-Null
            $prArgs = @(
                'pr', 'create', '--repo', $Repo, '--base', $DevelopBranch, '--head', $branch,
                '--title', 'テンプレート由来の名前を書き換える',
                '--body', 'scripts/setup.ps1 が CODEOWNERS、Issue の選択画面の URL、package.json の名前を書き換えました。'
            )
            if (Invoke-Step 'gh' $prArgs) {
                Write-Ok 'Pull Request を開いた。確かめてマージする'
            } else {
                Write-Warn "Pull Request を開けなかった。ブランチ ${branch} は push 済み"
            }
        } else {
            Write-Ok "書き換えた（コミットはしていない）: $($changed -join ' ')"
        }
    }
} else {
    Write-Warn 'リポジトリの中で実行していないため、名前の書き換えは飛ばした。clone の中で再実行する'
}

# ---- まとめ
Write-Host ''
if ($failures.Count -eq 0) {
    Write-Info 'すべて済みました'
} else {
    Write-Info "手で確かめる項目が $($failures.Count) 件あります"
    foreach ($f in $failures) { Write-Host "  - $f" }
}
Write-Host @'

残りは GitHub の画面で行います。
  - main と develop のルール（Pull Request 必須、Code scanning の結果）: Settings > Rules
  - SECURITY.md に非公開の連絡先を書く
  - package.json の description と README を書き換える
'@

exit ($failures.Count -eq 0 ? 0 : 1)
