// Logins in the vault are encrypted here, in the panel, with your vault passphrase. The Mac stores
// ciphertext only and never sees the passphrase (unless you ask it to remember it). AES-GCM with a
// key derived by PBKDF2; the vault's random salt keys it, so the same passphrase seals differently
// in another vault.

export const VAULT_KEY_VERSION = 1;
const ITERATIONS = 200_000;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toBase64(data: ArrayBuffer | Uint8Array): string {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export async function deriveVaultKey(passphrase: string, vaultId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", bytes(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bytes(`okidoki-vault:${vaultId}`), iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(key: CryptoKey, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes(secret));
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

/** Null when the passphrase is wrong or the ciphertext was tampered with. */
export async function decryptSecret(key: CryptoKey, ciphertext: string, iv: string): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

const PASSPHRASE_KEY = "okidoki.vault";

/** The passphrase remembered on this machine for an organization, if any. */
export function rememberedPassphrase(vaultId: string): string {
  try {
    const all = JSON.parse(window.localStorage.getItem(PASSPHRASE_KEY) ?? "{}") as Record<string, string>;
    return all[vaultId] ?? "";
  } catch {
    return "";
  }
}

export function rememberPassphrase(vaultId: string, passphrase: string | null) {
  try {
    const all = JSON.parse(window.localStorage.getItem(PASSPHRASE_KEY) ?? "{}") as Record<string, string>;
    if (passphrase) all[vaultId] = passphrase;
    else delete all[vaultId];
    window.localStorage.setItem(PASSPHRASE_KEY, JSON.stringify(all));
  } catch {}
}
