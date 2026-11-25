import { generateKeyPairSync, sign } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleAuth } from '../src/middleware/auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'google-test',
  alg: 'RS256',
  use: 'sig',
};
const now = 1_800_000_000_000;
const token = (
  claims: Record<string, unknown> = {},
  key = privateKey,
  header = { alg: 'RS256', kid: 'google-test' },
) => {
  const input = [
    header,
    {
      iss: 'https://accounts.google.com',
      aud: 'client',
      sub: 'google-user',
      exp: now / 1000 + 3600,
      ...claims,
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
};

describe('Google ID token boundary', () => {
  const build = async () => {
    const fetchKeys = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ keys: [jwk] })),
    );
    const authenticate = createGoogleAuth({
      audience: () => 'client',
      fetchKeys,
      now: () => now,
    });
    const app = Fastify();
    app.get(
      '/auth',
      { preHandler: authenticate },
      async (request) => request.auth,
    );
    await app.ready();
    return { app, fetchKeys };
  };
  it('verifies the signature and Google claims, caches keys, and ignores device identity after login', async () => {
    const { app, fetchKeys } = await build();
    try {
      for (const deviceId of ['first', 'second']) {
        const response = await app.inject({
          url: '/auth',
          headers: {
            authorization: `Bearer ${token()}`,
            'x-device-id': deviceId,
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          mode: 'authenticated',
          sub: 'google-user',
        });
      }
      expect(fetchKeys).toHaveBeenCalledTimes(1);
      expect(fetchKeys.mock.calls[0][0]).toBe(
        'https://www.googleapis.com/oauth2/v3/certs',
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    ['signature', () => token({}, otherKey)],
    ['expired', () => token({ exp: now / 1000 })],
    ['audience', () => token({ aud: 'another-client' })],
    ['issuer', () => token({ iss: 'https://attacker.example' })],
    ['subject', () => token({ sub: '' })],
    [
      'algorithm',
      () => token({}, privateKey, { alg: 'HS256', kid: 'google-test' }),
    ],
    ['malformed', () => 'invalid'],
  ])('rejects invalid %s without a guest downgrade', async (_, invalid) => {
    const { app } = await build();
    try {
      const response = await app.inject({
        url: '/auth',
        headers: {
          authorization: `Bearer ${invalid()}`,
          'x-device-id': 'guest',
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'INVALID_TOKEN' });
    } finally {
      await app.close();
    }
  });
  it.each([
    ['device', 'device'],
    [undefined, 'anonymous-device'],
    ['', 'anonymous-device'],
    ['  ', 'anonymous-device'],
  ])(
    'uses guest identity only when authorization is absent (%s)',
    async (deviceId, expected) => {
      const { app, fetchKeys } = await build();
      try {
        const response = await app.inject({
          url: '/auth',
          headers: deviceId === undefined ? {} : { 'x-device-id': deviceId },
        });
        expect(response.json()).toEqual({ mode: 'guest', deviceId: expected });
        expect(fetchKeys).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
