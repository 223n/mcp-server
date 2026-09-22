# 版は固定し、Dependabot が更新を提案する
FROM node:26.9.0-alpine3.24

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

USER node

EXPOSE 3000

CMD ["node", "index.js"]
