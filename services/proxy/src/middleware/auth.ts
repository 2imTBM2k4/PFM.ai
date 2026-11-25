import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type RequestAuth =
  { mode: 'authenticated'; sub: string } | { mode: 'guest'; deviceId: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth;
  }
}

/** Verify Google credentials before using any identity supplied in the token. */
export function createGoogleAuth(
  options: {
    audience?: () => string | undefined;
    fetchKeys?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const audience =
    options.audience ??
    (() =>
      process.env.GOOGLE_WEB_CLIENT_ID?.trim() ||
      process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim());
  let keys: (JsonWebKey & { kid?: string; use?: string; alg?: string })[] = [];
  let expiresAt = 0;
  let pending: Promise<void> | null = null;
  const loadKeys = async () => {
    if (now() < expiresAt) return;
    if (!pending)
      pending = (async () => {
        const response = await (options.fetchKeys ?? fetch)(
          'https://www.googleapis.com/oauth2/v3/certs',
          { signal: AbortSignal.timeout(5000) },
        );
        if (!response.ok) throw new Error('INVALID_TOKEN');
        const body = (await response.json()) as { keys?: typeof keys };
        if (
          !Array.isArray(body.keys) ||
          !body.keys.length ||
          body.keys.length > 32
        )
          throw new Error('INVALID_TOKEN');
        keys = body.keys;
        expiresAt = now() + 3_600_000;
      })().finally(() => {
        pending = null;
      });
    await pending;
  };
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      request.auth = {
        mode: 'guest',
        deviceId:
          String(request.headers['x-device-id'] ?? '').trim() ||
          'anonymous-device',
      };
      return;
    }
    try {
      const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
          authorization,
        );
      if (!match || match[1].length > 16_384 || !audience())
        throw new Error('INVALID_TOKEN');
      const [encodedHeader, encodedPayload, signature] = match[1].split('.');
      const header = JSON.parse(
        Buffer.from(encodedHeader, 'base64url').toString('utf8'),
      );
      if (
        header.alg !== 'RS256' ||
        typeof header.kid !== 'string' ||
        !header.kid ||
        header.kid.length > 128
      )
        throw new Error('INVALID_TOKEN');
      await loadKeys();
      const jwk = keys.find(
        (key) =>
          key.kid === header.kid &&
          key.kty === 'RSA' &&
          (!key.use || key.use === 'sig') &&
          (!key.alg || key.alg === 'RS256'),
      );
      if (
        !jwk ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          createPublicKey({ key: jwk, format: 'jwk' }),
          Buffer.from(signature, 'base64url'),
        )
      )
        throw new Error('INVALID_TOKEN');
      const claims = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      );
      if (
        claims.aud !== audience() ||
        !['accounts.google.com', 'https://accounts.google.com'].includes(
          claims.iss,
        ) ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= now() / 1000 ||
        typeof claims.sub !== 'string' ||
        !claims.sub.trim() ||
        claims.sub.length > 255 ||
        (claims.iat !== undefined &&
          (!Number.isFinite(claims.iat) || claims.iat > now() / 1000))
      )
        throw new Error('INVALID_TOKEN');
      request.auth = { mode: 'authenticated', sub: claims.sub };
    } catch {
      return reply.code(401).send({ error: 'INVALID_TOKEN' });
    }
  };
}

export const authenticateGoogle = createGoogleAuth();

/** Keep plan signatures isolated across authenticated and guest namespaces. */
export function planIdentity(auth: RequestAuth): string {
  return JSON.stringify([
    auth.mode,
    auth.mode === 'authenticated' ? auth.sub : auth.deviceId,
  ]);
}

export const authUserId = (auth: RequestAuth): string =>
  auth.mode === 'authenticated' ? auth.sub : auth.deviceId;
