import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const PIN_SCRYPT_COST = 128;
export const LEGACY_PIN_SCRYPT_COST = 65536;

// Uses a responsive scrypt cost for mobile Hermes while treating the hexadecimal salt as UTF-8 text.
export async function derivePinVerifier(pin: string, salt: string) {
  return bytesToHex(
    await scryptAsync(pin, salt, {
      N: PIN_SCRYPT_COST,
      r: 8,
      p: 1,
      dkLen: 32,
      maxmem: 4 * 1024 * 1024,
      asyncTick: 50,
    }),
  );
}

// Used only once to migrate a pre-existing high-cost v1 PIN record upon successful unlock.
export async function deriveLegacyPinVerifier(pin: string, salt: string) {
  return bytesToHex(
    await scryptAsync(pin, salt, {
      N: LEGACY_PIN_SCRYPT_COST,
      r: 8,
      p: 1,
      dkLen: 32,
      maxmem: 128 * 1024 * 1024,
      asyncTick: 50,
    }),
  );
}
