import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const wrappingKeyRef = "local:media-kek:v1";

export function parseKek(value: string | undefined) {
  if (!value || !/^[0-9a-f]{64}$/i.test(value))
    throw new Error("MEDIA_KEK must contain exactly 64 hexadecimal characters");
  return Buffer.from(value, "hex");
}

type Sealed = { nonce: Buffer; ciphertext: Buffer; tag: Buffer };

function seal(key: Buffer, data: Buffer, context: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

function open(key: Buffer, sealed: Sealed, context: string) {
  const cipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(sealed.tag);
  return Buffer.concat([cipher.update(sealed.ciphertext), cipher.final()]);
}

export function wrapMediaKey(kek: Buffer, mediaKey: Buffer, kid: string) {
  if (mediaKey.length !== 16) throw new Error("Expected a 128-bit media key");
  const dek = randomBytes(32);
  try {
    const wrapped = seal(kek, dek, wrappingKeyRef + ":dek:" + kid);
    return {
      ...seal(dek, mediaKey, wrappingKeyRef + ":media:" + kid),
      wrappedDek: Buffer.concat([
        wrapped.nonce,
        wrapped.tag,
        wrapped.ciphertext,
      ]),
    };
  } finally {
    dek.fill(0);
  }
}

export function unwrapMediaKey(
  kek: Buffer,
  envelope: Sealed & { wrappedDek: Buffer },
  kid: string,
) {
  const wrapped = envelope.wrappedDek;
  if (wrapped.length !== 60) throw new Error("Invalid wrapped DEK");
  const dek = open(
    kek,
    {
      nonce: wrapped.subarray(0, 12),
      tag: wrapped.subarray(12, 28),
      ciphertext: wrapped.subarray(28),
    },
    wrappingKeyRef + ":dek:" + kid,
  );
  try {
    return open(dek, envelope, wrappingKeyRef + ":media:" + kid);
  } finally {
    dek.fill(0);
  }
}
