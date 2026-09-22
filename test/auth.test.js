import assert from "node:assert/strict";

import { generateKeyPairSync, sign } from "node:crypto";

import { after, test } from "node:test";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.js";

process.chdir(WORK_DIR);

after(removeCreatedTrees);

process.env.CF_ACCESS_TEAM_DOMAIN = "team.example.cloudflareaccess.com";

process.env.CF_ACCESS_AUD = "aud-123";

process.env.CF_ACCESS_ALLOWED_EMAILS = "Me@Example.com";

process.env.MCP_AUTH_TOKEN = "static-token";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

let certFetches = 0;

// Cloudflare Access の公開鍵の取得だけを差し替える
globalThis.fetch = async (url) => {
  if (String(url) === "https://team.example.cloudflareaccess.com/cdn-cgi/access/certs") {
    certFetches += 1;

    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    });
  }

  throw new Error(`unexpected fetch: ${url}`);
};

const { createAuthMiddleware, verifyAccessJwt } = await import("../src/http/auth.js");

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

const now = Math.floor(Date.now() / 1000);

const good = {
  aud: ["aud-123"],

  iss: "https://team.example.cloudflareaccess.com",

  exp: now + 300,

  iat: now,

  email: "me@example.com",
};

function makeToken(payload, { kid = "k1", alg = "RS256", key = privateKey } = {}) {
  const header = b64({ alg, kid, typ: "JWT" });

  const body = b64(payload);

  const signature =
    alg === "none" ? "" : sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key).toString("base64url");

  return `${header}.${body}.${signature}`;
}

test("正しい JWT は中身を返す", async () => {
  assert.equal((await verifyAccessJwt(makeToken(good))).email, "me@example.com");

  assert.ok(await verifyAccessJwt(makeToken({ ...good, aud: "aud-123" })));
});

for (const [name, token] of [
  ["aud が違う", () => makeToken({ ...good, aud: ["other"] })],
  ["iss が違う", () => makeToken({ ...good, iss: "https://evil.cloudflareaccess.com" })],
  ["期限切れ", () => makeToken({ ...good, exp: now - 3600 })],
  ["まだ有効でない", () => makeToken({ ...good, nbf: now + 3600 })],
  ["別の鍵で署名", () => makeToken(good, { key: other.privateKey })],
  ["alg が none", () => makeToken(good, { alg: "none" })],
  ["知らない kid", () => makeToken(good, { kid: "unknown" })],
  [
    "中身の改ざん",
    () => {
      const parts = makeToken(good).split(".");

      parts[1] = b64({ ...good, email: "admin@example.com" });

      return parts.join(".");
    },
  ],
  ["形が違う", () => "a.b"],
]) {
  test(`拒む: ${name}`, async () => {
    assert.equal(await verifyAccessJwt(token()), null);
  });
}

test("知らない kid で鍵を取り直すのは間隔を空ける", () => {
  assert.ok(certFetches <= 2, `certs fetched ${certFetches} times`);
});

// Express のリクエストとレスポンスを最小限に真似て、ミドルウェアを通す
async function runMiddleware(headers) {
  const middleware = createAuthMiddleware();

  let status = 200;

  let passed = false;

  const res = {
    status(code) {
      status = code;

      return this;
    },

    json() {
      return this;
    },
  };

  const req = { headers };

  await middleware(req, res, () => {
    passed = true;
  });

  return passed ? 200 : status;
}

// 監査に残す識別子だけを取り出す
async function identityFor(headers) {
  const middleware = createAuthMiddleware();

  const req = { headers };

  await middleware(req, { status: () => ({ json: () => {} }) }, () => {});

  return req.mcpIdentity;
}

test("ミドルウェア: 静的なトークンで通る", async () => {
  assert.equal(await runMiddleware({ authorization: "Bearer static-token" }), 200);
});

test("ミドルウェア: 違うトークンは 401", async () => {
  assert.equal(await runMiddleware({ authorization: "Bearer wrong" }), 401);
});

test("ミドルウェア: 許可したメールアドレスの JWT で通る（大文字小文字は区別しない）", async () => {
  assert.equal(await runMiddleware({ "cf-access-jwt-assertion": makeToken(good) }), 200);
});

test("ミドルウェア: 許可していないメールアドレスの JWT は 401", async () => {
  const token = makeToken({ ...good, email: "other@example.com" });

  assert.equal(await runMiddleware({ "cf-access-jwt-assertion": token }), 401);
});

test("ミドルウェア: email のない JWT（サービストークン）は、絞り込みがあると 401", async () => {
  const { email, ...serviceToken } = good;

  assert.ok(email);

  const token = makeToken({ ...serviceToken, common_name: "service-token-id.access" });

  assert.ok(await verifyAccessJwt(token), "the JWT itself is valid");

  assert.equal(await runMiddleware({ "cf-access-jwt-assertion": token }), 401);
});

test("ミドルウェア: 資格情報がなければ 401", async () => {
  assert.equal(await runMiddleware({}), 401);
});

test("監査の識別子: トークンで通ったときは token", async () => {
  assert.equal(await identityFor({ authorization: "Bearer static-token" }), "token");
});

test("監査の識別子: Access の JWT では email を使う", async () => {
  assert.equal(
    await identityFor({ "cf-access-jwt-assertion": makeToken(good) }),
    "me@example.com",
  );
});

test("監査の識別子: email のない JWT では sub を使う", async () => {
  const { config } = await import("../src/config/config.js");

  const { email, ...serviceToken } = good;

  assert.ok(email);

  // email での絞り込みを外さないと、サービストークンはそもそも 401 になる
  const saved = config.cfAccessAllowedEmails;

  config.cfAccessAllowedEmails = [];

  try {
    assert.match(
      String(await identityFor({ "cf-access-jwt-assertion": makeToken(serviceToken) })),
      /^sub:/,
    );
  } finally {
    config.cfAccessAllowedEmails = saved;
  }
});

test("監査の識別子: 通らなかったときは付かない", async () => {
  assert.equal(await identityFor({ authorization: "Bearer wrong" }), undefined);
});
