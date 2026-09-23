import type { KeyObject, webcrypto } from "node:crypto";

import { createPublicKey, timingSafeEqual, verify } from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { config } from "../config/config.ts";

/**
 * Cloudflare Access の JWT の中身。
 *
 * 相手から来る値なので、どれも「あるかもしれない」形にしておき、
 * verifyAccessJwt がそろっているかを確かめます。
 */
export type AccessPayload = {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  sub?: string;
};

type JwtHeader = { alg?: string; kid?: string };

const JWKS_TTL_MS = 60 * 60 * 1000;

const JWKS_MIN_REFRESH_MS = 60 * 1000;

let jwks: { keys: Map<string, KeyObject>; fetchedAt: number } = {
  keys: new Map(),
  fetchedAt: 0,
};

async function loadKeys({ force = false }: { force?: boolean } = {}): Promise<Map<string, KeyObject>> {
  const age = Date.now() - jwks.fetchedAt;

  if (jwks.keys.size > 0 && (force ? age < JWKS_MIN_REFRESH_MS : age < JWKS_TTL_MS)) {
    return jwks.keys;
  }

  const response = await fetch(`https://${config.cfAccessTeamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare Access certs returned HTTP ${response.status}`);
  }

  const { keys = [] } = (await response.json()) as { keys?: (webcrypto.JsonWebKey & { kid?: string })[] };

  jwks = {
    keys: new Map(
      keys
        .filter((jwk) => typeof jwk.kid === "string")
        .map((jwk): [string, KeyObject] => [
          jwk.kid as string,
          createPublicKey({ key: jwk, format: "jwk" }),
        ]),
    ),

    fetchedAt: Date.now(),
  };

  return jwks.keys;
}

const decode = <T>(part: string): T =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;

// Cloudflare Access がオリジンに付ける Cf-Access-Jwt-Assertion を検証する。
// 正しければ中身（payload）を、そうでなければ null を返す
export async function verifyAccessJwt(token: string): Promise<AccessPayload | null> {
  const parts = token.split(".");

  // 段が 3 つちょうどでなければ受け取らない。分割代入だけにすると "a.b.c.d" も通ってしまう
  if (parts.length !== 3) {
    return null;
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    return null;
  }

  const header = decode<JwtHeader>(headerPart);

  const payload = decode<AccessPayload>(payloadPart);

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    return null;
  }

  let key = (await loadKeys()).get(header.kid);

  if (!key) {
    key = (await loadKeys({ force: true })).get(header.kid);
  }

  if (!key) {
    return null;
  }

  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart, "base64url"),
  );

  if (!signed) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

  const valid =
    audiences.includes(config.cfAccessAud) &&
    payload.iss === `https://${config.cfAccessTeamDomain}` &&
    typeof payload.exp === "number" &&
    payload.exp > now - 60 &&
    (payload.nbf === undefined || payload.nbf <= now + 60);

  return valid ? payload : null;
}

// CF_ACCESS_ALLOWED_EMAILS が空なら全員、設定があれば一覧にある email だけを通す
function isAllowedIdentity(payload: AccessPayload): boolean {
  if (config.cfAccessAllowedEmails.length === 0) {
    return true;
  }

  return (
    typeof payload.email === "string" &&
    config.cfAccessAllowedEmails.includes(payload.email.toLowerCase())
  );
}

function matchesToken(header: string | undefined, expected: Buffer): boolean {
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const given = Buffer.from(header.slice("Bearer ".length));

  return given.length === expected.length && timingSafeEqual(given, expected);
}

// MCP_AUTH_TOKEN と CF_ACCESS_* のどちらも未設定なら null（認証なし）を返す
export function createAuthMiddleware(): RequestHandler | null {
  const token = config.mcpAuthToken ? Buffer.from(config.mcpAuthToken) : undefined;

  const accessEnabled = Boolean(config.cfAccessTeamDomain && config.cfAccessAud);

  if (!token && !accessEnabled) {
    return null;
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (token && matchesToken(req.headers.authorization, token)) {
        // 静的なトークンには識別子が無い。監査では「トークンで通った」ことだけ分かる
        req.mcpIdentity = "token";

        return next();
      }

      const assertion = req.headers["cf-access-jwt-assertion"];

      if (accessEnabled && typeof assertion === "string") {
        const payload = await verifyAccessJwt(assertion);

        if (payload && isAllowedIdentity(payload)) {
          // 監査に残す識別子。email が無いサービストークンは sub で見分ける
          req.mcpIdentity = payload.email ?? `sub:${payload.sub ?? "unknown"}`;

          return next();
        }

        if (payload) {
          console.error("[auth] Access identity is not in CF_ACCESS_ALLOWED_EMAILS");
        }
      }
    } catch (error) {
      console.error("[auth]", error instanceof Error ? error.message : error);
    }

    res.status(401).json({
      jsonrpc: "2.0",

      error: {
        code: -32001,

        message: "Unauthorized",
      },

      id: null,
    });
  };
}
