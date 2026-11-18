import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  parseKek,
  wrapMediaKey,
  unwrapMediaKey,
} from "../dist/media-crypto.js";

test("envelopes authenticate the KID, wrapping key, and both AEAD layers", () => {
  const kek = randomBytes(32);
  const kid = randomUUID();
  const key = randomBytes(16);
  const envelope = wrapMediaKey(kek, key, kid);
  assert.deepEqual(unwrapMediaKey(kek, envelope, kid), key);
  assert.notDeepEqual(
    wrapMediaKey(kek, key, kid).wrappedDek,
    envelope.wrappedDek,
  );
  assert.throws(() => unwrapMediaKey(kek, envelope, randomUUID()));
  assert.throws(() => unwrapMediaKey(randomBytes(32), envelope, kid));
  for (const field of ["wrappedDek", "nonce", "ciphertext", "tag"]) {
    const tampered = Buffer.from(envelope[field]);
    tampered[0] ^= 1;
    assert.throws(() =>
      unwrapMediaKey(kek, { ...envelope, [field]: tampered }, kid),
    );
  }
});

test("KEK requires exactly 32 hex-encoded bytes", () => {
  for (const invalid of [undefined, "", "xx".repeat(32), "00".repeat(33)]) {
    assert.throws(() => parseKek(invalid));
  }
  assert.deepEqual(parseKek("ab".repeat(32)), Buffer.alloc(32, 0xab));
});
