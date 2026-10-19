// VAPID（RFC 8292）: ES256 の JWT。aud は送り先のオリジン、exp は 12 時間、sub は VAPID_SUBJECT（DESIGN-v2 10.3）
import { base64url, base64urlDecode } from "../lib/crypto.ts";
import { p256PointToJwk } from "./ece.ts";

export const VAPID_EXP_SEC = 12 * 60 * 60;

const b64json = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));

export async function importVapidPrivateKey(publicKeyB64: string, privateKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { ...p256PointToJwk(base64urlDecode(publicKeyB64)), d: privateKeyB64 }, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

/** JWT（header.claims.signature。署名は r‖s の 64 バイト＝JOSE の形） */
export async function vapidJwt(endpoint: string, keys: { publicKey: string; privateKey: string; subject: string }, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const unsigned = `${b64json({ typ: "JWT", alg: "ES256" })}.${b64json({ aud, exp: nowSec + VAPID_EXP_SEC, sub: keys.subject })}`;
  const key = await importVapidPrivateKey(keys.publicKey, keys.privateKey);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${base64url(sig)}`;
}

export async function vapidAuthorization(endpoint: string, keys: { publicKey: string; privateKey: string; subject: string }): Promise<string> {
  return `vapid t=${await vapidJwt(endpoint, keys)}, k=${keys.publicKey}`;
}
