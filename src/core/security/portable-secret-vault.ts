import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { z } from "zod";
import { SecretProtectionError } from "./dpapi-secret-vault.js";

const keyLength = 32;
const saltLength = 16;
const nonceLength = 12;
const authTagLength = 16;
const scryptCost = 32_768;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptMaxMemory = 64 * 1024 * 1024;
const authenticatedData = Buffer.from("providerdock:portable-secret:v1", "utf8");

const base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "Expected base64 data.");
const portableSecretEnvelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    kdf: z
      .object({
        name: z.literal("scrypt"),
        cost: z.literal(scryptCost),
        blockSize: z.literal(scryptBlockSize),
        parallelization: z.literal(scryptParallelization),
        keyLength: z.literal(keyLength),
      })
      .strict(),
    salt: base64Schema,
    nonce: base64Schema,
    authTag: base64Schema,
    ciphertext: base64Schema,
  })
  .strict();

export type PortableSecretEnvelope = z.infer<typeof portableSecretEnvelopeSchema>;

export async function encryptPortableSecretPayload(
  payload: unknown,
  passphrase: string,
): Promise<PortableSecretEnvelope> {
  assertPassphrase(passphrase);
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new SecretProtectionError("Portable credential backup payload is not serializable.");
  }

  try {
    const salt = randomBytes(saltLength);
    const nonce = randomBytes(nonceLength);
    const key = await derivePortableKey(passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(authenticatedData);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(serialized, "utf8")),
      cipher.final(),
    ]);
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      kdf: {
        name: "scrypt",
        cost: scryptCost,
        blockSize: scryptBlockSize,
        parallelization: scryptParallelization,
        keyLength,
      },
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } catch (error) {
    if (error instanceof SecretProtectionError) throw error;
    throw new SecretProtectionError("Portable credential backup could not be created.", {
      cause: error,
    });
  }
}

export async function decryptPortableSecretPayload<T = unknown>(
  envelope: unknown,
  passphrase: string,
): Promise<T> {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new SecretProtectionError("Portable credential backup passphrase is required.");
  }
  const parsed = portableSecretEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new SecretProtectionError("Portable credential backup could not be opened.");
  }

  try {
    const salt = Buffer.from(parsed.data.salt, "base64");
    const nonce = Buffer.from(parsed.data.nonce, "base64");
    const authTag = Buffer.from(parsed.data.authTag, "base64");
    const ciphertext = Buffer.from(parsed.data.ciphertext, "base64");
    if (
      salt.length !== saltLength ||
      nonce.length !== nonceLength ||
      authTag.length !== authTagLength ||
      ciphertext.length === 0
    ) {
      throw new Error("Invalid portable envelope dimensions.");
    }

    const key = await derivePortableKey(passphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(authenticatedData);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as T;
  } catch (error) {
    throw new SecretProtectionError("Portable credential backup could not be opened.", {
      cause: error,
    });
  }
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new SecretProtectionError("Portable credential backup passphrase is required.");
  }
}

async function derivePortableKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      keyLength,
      {
        N: scryptCost,
        r: scryptBlockSize,
        p: scryptParallelization,
        maxmem: scryptMaxMemory,
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(Buffer.from(derived));
      },
    );
  });
}
