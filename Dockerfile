# 版とダイジェストで固定し、Dependabot が両方の更新を提案する。
# タグに Alpine の版（alpine3.24 など）を含めると、Alpine が上がったときに Dependabot が追えなくなるため含めない
FROM node:26.9.0-alpine@sha256:dbaa92e5758cbbcf85d65d5403fdb530fe3442cbe8c6dbfb7ef23365450d5070

ENV NODE_ENV=production

# git のツール用。github-cli は入れない（REST API を直に使うため、gh api や gh alias という
# 別の実行経路が増えない）。
#
# 設定は /etc/gitconfig ではなく専用の 1 枚に置き、GIT_CONFIG_SYSTEM でそれだけを読ませる。
# 取得したリポジトリの .git/config（local）はこれでも読まれるため、src/git/exec.ts がコマンドの側の設定で
# 危険な鍵を打ち消し、src/tools/git.ts が操作の前に鍵を許可リストで確かめる。
# safe.directory は、Windows のバインドマウントが別の所有者に見えるために要る。
# protocol の指定で ext::、file://、git://、ssh:// を塞ぎ、https だけを通す。
#
# ファイルは git config に書かせる。printf の %s は引数の \t を展開しないため、手で書くと
# 「\tdirectory = *」がそのまま残る。git はこれを「bad config line 2」として読めず、git の操作がすべて失敗する
RUN apk add --no-cache git \
    && mkdir -p /etc/git /tmp/git-home \
    && git config --file /etc/git/server.gitconfig safe.directory '*' \
    && git config --file /etc/git/server.gitconfig protocol.allow never \
    && git config --file /etc/git/server.gitconfig protocol.https.allow always \
    && chown node:node /tmp/git-home

# 監査ログの書き出し先。docker-compose.yml が名前付きボリュームをここにマウントする。
# 新しいボリュームは、イメージのこのディレクトリの持ち主（node）を引き継ぐ
RUN mkdir -p /var/log/ollama-mcp && chown node:node /var/log/ollama-mcp

WORKDIR /app

COPY package.json package-lock.json ./

# 実行時に使うのは node だけなので、依存を入れたら、ベースイメージに同梱の npm と npx を消す。
# 同梱の npm の依存（brace-expansion、undici など）に脆弱性が見つかっても、その版は npm とベースイメージが
# 上げるまで変えられない。使わないものを残して、Trivy の検査が落ち続けることを避ける
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY . .

USER node

EXPOSE 3000

CMD ["node", "index.ts"]
