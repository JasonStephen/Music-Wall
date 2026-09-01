// 网易云 API 加密层，与 go-music-dl/music-lib 的 netease/crypto.go 严格对齐。
// - EncryptLinux: AES-128-ECB + PKCS7，输出大写 HEX（用于 /api/linux/forward 的 eparams）
// - EncryptWeApi: 双轮 AES-128-CBC + RSA NoPadding（用于 /weapi/* 的 params / encSecKey）
// AES 使用 @noble/ciphers（自动 PKCS7 填充，与 Go 端手动 pkcs7Padding 等价），
// RSA-NoPadding 用 BigInt 模幂自实现，跨桌面/移动端 webview 可用。

import { cbc, ecb } from "@noble/ciphers/aes.js";

// ---- 常量（源自 music-lib netease/crypto.go，逐字符核对） ----

const LINUX_API_KEY_HEX = "7246674226682325323F5E6544673A51";
const WE_API_NONCE = "0CoJUm6Qyw8W8jud";
const WE_API_IV = "0102030405060708";
const WE_API_PUB_KEY = "010001";
const WE_API_PUB_MODULUS =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
const SEC_KEY_LETTERS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ---- 字节/编码工具 ----

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexLower(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function randomString(size: number): string {
  const buf = new Uint8Array(size);
  crypto.getRandomValues(buf);
  let result = "";
  for (let i = 0; i < size; i++) {
    result += SEC_KEY_LETTERS[buf[i] % SEC_KEY_LETTERS.length];
  }
  return result;
}

// ---- RSA NoPadding（BigInt 模幂） ----

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

/** 对应 Go rsaEncrypt：反转字符串 → 每字节 hex → m^e mod n → 256 位小写 hex */
function rsaNoPadding(text: string): string {
  const reversed = [...text].reverse().join("");
  const hexText = bytesToHexLower(utf8ToBytes(reversed));
  const m = BigInt("0x" + hexText);
  const e = BigInt("0x" + WE_API_PUB_KEY);
  const n = BigInt("0x" + WE_API_PUB_MODULUS);
  return modpow(m, e, n).toString(16).padStart(256, "0");
}

// ---- AES ----

function aesEcbEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  return ecb(key).encrypt(data);
}

function aesCbcEncrypt(text: string, key: string, iv: string): string {
  const c = cbc(utf8ToBytes(key), utf8ToBytes(iv));
  return bytesToBase64(c.encrypt(utf8ToBytes(text)));
}

// ---- 对外接口 ----

/**
 * Linux API 加密：对应 music-lib EncryptLinux / Python encode_netease_data。
 * 输入 JSON 字符串，输出大写 HEX，作为 linux/forward 的 eparams 字段。
 */
export function encryptLinux(paramsJson: string): string {
  const key = hexToBytes(LINUX_API_KEY_HEX);
  const encrypted = aesEcbEncrypt(utf8ToBytes(paramsJson), key);
  return bytesToHexLower(encrypted).toUpperCase();
}

/**
 * WeApi 加密：对应 music-lib EncryptWeApi / Python encrypted_request。
 * 输入 JSON 字符串，返回表单字段 params 与 encSecKey。
 */
export function encryptWeApi(text: string): {
  params: string;
  encSecKey: string;
} {
  const secKey = randomString(16);
  const firstRound = aesCbcEncrypt(text, WE_API_NONCE, WE_API_IV);
  const params = aesCbcEncrypt(firstRound, secKey, WE_API_IV);
  const encSecKey = rsaNoPadding(secKey);
  return { params, encSecKey };
}
