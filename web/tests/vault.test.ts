import { describe, expect, test } from "bun:test";
import { decryptSecret, deriveVaultKey, encryptSecret } from "../src/vaultCrypto";

describe("vault credentials", () => {
  test("a secret round-trips through the passphrase and never appears in the ciphertext", async () => {
    const key = await deriveVaultKey("correct horse battery staple", "org-1");
    const sealed = await encryptSecret(key, "hunter2!");
    expect(sealed.ciphertext).not.toContain("hunter2");
    expect(sealed.iv).toHaveLength(16);
    expect(await decryptSecret(key, sealed.ciphertext, sealed.iv)).toBe("hunter2!");
  });

  test("each encryption uses a fresh nonce", async () => {
    const key = await deriveVaultKey("pass", "org-1");
    const a = await encryptSecret(key, "same");
    const b = await encryptSecret(key, "same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("the wrong passphrase, another organization, or a tampered box gives nothing back", async () => {
    const key = await deriveVaultKey("pass", "org-1");
    const sealed = await encryptSecret(key, "secret");
    expect(await decryptSecret(await deriveVaultKey("pass ", "org-1"), sealed.ciphertext, sealed.iv)).toBeNull();
    expect(await decryptSecret(await deriveVaultKey("pass", "org-2"), sealed.ciphertext, sealed.iv)).toBeNull();
    const tampered = sealed.ciphertext.slice(0, -4) + (sealed.ciphertext.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await decryptSecret(key, tampered, sealed.iv)).toBeNull();
  });
});
