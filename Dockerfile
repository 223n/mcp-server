# 版とダイジェストで固定し、Dependabot が両方の更新を提案する。
# タグに Alpine の版（alpine3.24 など）を含めると、Alpine が上がったときに Dependabot が追えなくなるため含めない
FROM node:26.9.0-alpine@sha256:dbaa92e5758cbbcf85d65d5403fdb530fe3442cbe8c6dbfb7ef23365450d5070

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

USER node

EXPOSE 3000

CMD ["node", "index.js"]
