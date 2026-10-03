import crypto from "crypto";
import { env } from "../config/env";

/**
 * Symmetric encryption for third-party credentials we have to store and replay
 * -- currently WhatsApp access tokens and app secrets.
 *
 * These are not passwords: we need the original value back to call Meta's API,
 * so hashing is not an option. AES-256-GCM is used rather than CBC because it
 * authenticates the ciphertext, so a tampered-with row fails to decrypt instead
 * of silently yielding garbage we would then send to Meta.
 *
 * A leaked access token lets someone send messages as the factory, so these
 * never appear in an API response -- see `maskSecret`.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, the size GCM is specified for
const KEY_LENGTH = 32;

/**
 * Derives the 32-byte key.
 *
 * `ENCRYPTION_KEY` should be 64 hex characters (`openssl rand -hex 32`). If it
 * is absent we fall back to a key derived from JWT_SECRET so a dev machine
 * works out of the box -- but that ties credential encryption to a secret with
 * a different rotation story, so production should always set its own.
 */
function getKey(): Buffer {
  const configured = env.encryptionKey;

  if (configured) {
    if (/^[0-9a-f]{64}$/i.test(configured)) {
      return Buffer.from(configured, "hex");
    }
    // Any other string: stretch it rather than refusing to boot.
    return crypto.createHash("sha256").update(configured).digest();
  }

  return crypto
    .createHash("sha256")
    .update(`kayanflow:fallback:${env.jwtSecret}`)
    .digest();
}

let warned = false;
function warnOnce() {
  if (!warned && !env.encryptionKey) {
    warned = true;
    console.warn(
      "[crypto] ENCRYPTION_KEY is not set -- stored credentials use a key derived " +
        "from JWT_SECRET. Set ENCRYPTION_KEY (openssl rand -hex 32) in production; " +
        "rotating JWT_SECRET would otherwise make stored tokens undecryptable."
    );
  }
}

/** Returns "iv:authTag:ciphertext", all hex. */
export function encryptSecret(plaintext: string): string {
  warnOnce();
  if (!plaintext) return "";

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

/**
 * Reverses `encryptSecret`. Returns null rather than throwing when the value is
 * missing or undecryptable -- a rotated key shouldn't crash a request, it
 * should surface as "WhatsApp needs reconnecting".
 */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;

  const parts = payload.split(":");
  if (parts.length !== 3) return null;

  try {
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      getKey(),
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));

    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * What the dashboard shows instead of the real token: enough to recognise which
 * credential is saved, not enough to use it.
 */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** A random token for Meta's webhook verification handshake. */
export function generateVerifyToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Constant-time comparison, so a caller can't learn a secret one byte at a time
 * by measuring how long the comparison took.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
