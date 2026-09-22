import { createPublicKey, timingSafeEqual, verify } from "node:crypto";

import { config } from "../config/config.js";

const JWKS_TTL_MS = 60 * 60 * 1000;

const JWKS_MIN_REFRESH_MS = 60 * 1000;

let jwks = { keys: new Map(), fetchedAt: 0 };

async function loadKeys({ force = false } = {}) {
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

  const { keys = [] } = await response.json();

  jwks = {
    keys: new Map(keys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: "jwk" })])),

    fetchedAt: Date.now(),
  };

  return jwks.keys;
}

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

// Cloudflare Access がオリジンに付ける Cf-Access-Jwt-Assertion を検証する
export async function verifyAccessJwt(token) {
  const parts = token.split(".");

  if (parts.length !== 3) {
    return false;
  }

  const header = decode(parts[0]);

  const payload = decode(parts[1]);

  if (header.alg !== "RS256") {
    return false;
  }

  let key = (await loadKeys()).get(header.kid);

  if (!key) {
    key = (await loadKeys({ force: true })).get(header.kid);
  }

  if (!key) {
    return false;
  }

  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], "base64url"),
  );

  if (!signed) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

  return (
    audiences.includes(config.cfAccessAud) &&
    payload.iss === `https://${config.cfAccessTeamDomain}` &&
    typeof payload.exp === "number" &&
    payload.exp > now - 60 &&
    (payload.nbf === undefined || payload.nbf <= now + 60)
  );
}

function matchesToken(header, expected) {
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const given = Buffer.from(header.slice("Bearer ".length));

  return given.length === expected.length && timingSafeEqual(given, expected);
}

// MCP_AUTH_TOKEN と CF_ACCESS_* のどちらも未設定なら null（認証なし）を返す
export function createAuthMiddleware() {
  const token = config.mcpAuthToken ? Buffer.from(config.mcpAuthToken) : undefined;

  const accessEnabled = Boolean(config.cfAccessTeamDomain && config.cfAccessAud);

  if (!token && !accessEnabled) {
    return null;
  }

  return async (req, res, next) => {
    try {
      if (token && matchesToken(req.headers.authorization, token)) {
        return next();
      }

      const assertion = req.headers["cf-access-jwt-assertion"];

      if (accessEnabled && typeof assertion === "string" && (await verifyAccessJwt(assertion))) {
        return next();
      }
    } catch (error) {
      console.error("[auth]", error.message);
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
