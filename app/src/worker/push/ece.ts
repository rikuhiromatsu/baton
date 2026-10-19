// Web Push の暗号化（RFC 8291、aes128gcm。RFC 8188 のレコード 1 つ）を WebCrypto で自前に実装する（DESIGN-v2 10.3・D-89）。
// 端末の公開鍵（p256dh）と使い捨ての P-256 鍵で ECDH → HKDF-SHA-256 → AES-128-GCM。区切りは 0x02（最後のレコード）。
import { base64urlDecode, concatBytes } from "../lib/crypto.ts";

const enc = new TextEncoder();

/** ECDH の deriveBits の引数（実行時の名前は WebCrypto どおり public。workers-types は $public と書く） */
function ecdhParams(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}

/** レコードの大きさ（ヘッダの rs）。本文は 3KB 以内なので 1 レコードに収まる */
export const RECORD_SIZE = 4096;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(data)));
}

/** HKDF（RFC 5869）の extract と expand（長さは 32 以下） */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concatBytes(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

/** 非圧縮の P-256 公開鍵（65 バイト）を JWK の x・y にする */
export function p256PointToJwk(point: Uint8Array): { kty: "EC"; crv: "P-256"; x: string; y: string } {
  if (point.length !== 65 || point[0] !== 4) throw new Error("invalid P-256 public key");
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { kty: "EC", crv: "P-256", x: b64(point.slice(1, 33)), y: b64(point.slice(33, 65)) };
}

export type EceKeys = {
  /** 送り手（アプリケーションサーバー）の使い捨ての鍵。テストでだけ固定値を渡す */
  serverKeyPair?: { privateKey: CryptoKey; publicKeyRaw: Uint8Array<ArrayBuffer> };
  salt?: Uint8Array;
};

export async function generateServerKeyPair(): Promise<{ privateKey: CryptoKey; publicKeyRaw: Uint8Array<ArrayBuffer> }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicKeyRaw: new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
}

/** 固定の秘密鍵（JWK の d）と公開鍵（非圧縮）から送り手の鍵を作る（RFC 8291 付録 A の試験用） */
export async function importServerKeyPair(publicKeyB64: string, privateKeyB64: string) {
  const publicKeyRaw = base64urlDecode(publicKeyB64);
  const privateKey = await crypto.subtle.importKey("jwk", { ...p256PointToJwk(publicKeyRaw), d: privateKeyB64 }, { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return { privateKey, publicKeyRaw };
}

/**
 * 本文を暗号化して、HTTP の本文（ヘッダ salt‖rs‖idlen‖keyid ＋ 暗号文）を返す。
 * uaPublic: 購読の keys.p256dh（base64url）、authSecret: keys.auth（base64url）
 */
export async function encryptPushPayload(plaintext: Uint8Array, uaPublicB64: string, authSecretB64: string, keys: EceKeys = {}): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = base64urlDecode(uaPublicB64);
  const authSecret = base64urlDecode(authSecretB64);
  const server = keys.serverKeyPair ?? (await generateServerKeyPair());
  const salt = new Uint8Array(keys.salt ?? crypto.getRandomValues(new Uint8Array(16)));

  const uaKey = await crypto.subtle.importKey("jwk", p256PointToJwk(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(uaKey), server.privateKey, 256));

  // RFC 8291 3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public, 32)
  const keyInfo = concatBytes(enc.encode("WebPush: info\0"), uaPublic, server.publicKeyRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // RFC 8188 2.2・2.3
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const padded = concatBytes(plaintext, new Uint8Array([2]));
  if (padded.length + 16 > RECORD_SIZE) throw new Error("payload too large");
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = server.publicKeyRaw.length;
  return concatBytes(header, server.publicKeyRaw, ciphertext);
}

/** 受け手側の復号（テストと e2e の偽のプッシュサービス用） */
export async function decryptPushPayload(body: Uint8Array, uaPrivate: CryptoKey, uaPublicRaw: Uint8Array, authSecret: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const serverPublic = body.slice(21, 21 + idlen);
  const ciphertext = new Uint8Array(body.slice(21 + idlen));
  const serverKey = await crypto.subtle.importKey("jwk", p256PointToJwk(serverPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(serverKey), uaPrivate, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concatBytes(enc.encode("WebPush: info\0"), uaPublicRaw, serverPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("invalid padding delimiter");
  return padded.slice(0, end);
}
