import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
let secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
  }
  secret = randomBytes(48).toString('base64url');
  console.warn('[security] JWT_SECRET is not set; using an ephemeral development secret. Set JWT_SECRET in .env for stable local sessions.');
}
export async function hashPassword(password) { const salt = randomBytes(16); const key = await scrypt(password, salt, 64); return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`; }
export async function verifyPassword(password, stored) { const [scheme, saltHex, keyHex] = String(stored).split('$'); if (scheme !== 'scrypt' || !saltHex || !keyHex) return false; const expected = Buffer.from(keyHex, 'hex'); const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length); return expected.length === actual.length && timingSafeEqual(expected, actual); }
const b64 = (value) => Buffer.from(value).toString('base64url');
export const randomToken = (bytes = 48) => randomBytes(bytes).toString('base64url');
export const hashToken = (value) => createHmac('sha256', secret).update(String(value)).digest('hex');
function signature(input) { return createHmac('sha256', secret).update(input).digest('base64url'); }

const encryptionKey = createHmac('sha256', secret).update('ashkan-board-totp-encryption').digest();
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buffer) { let bits = 0; let value = 0; let out = ''; for (const byte of buffer) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += base32Alphabet[(value << (5 - bits)) & 31]; return out; }
export function base32Decode(input) { const clean = String(input || '').replace(/=+$/,'').toUpperCase().replace(/\s+/g,''); let bits=0,value=0; const out=[]; for (const char of clean) { const index=base32Alphabet.indexOf(char); if(index<0) throw new Error('Invalid base32 secret'); value=(value<<5)|index; bits+=5; if(bits>=8){ out.push((value >>> (bits-8))&255); bits-=8; } } return Buffer.from(out); }
export function generateTotpSecret() { return base32Encode(randomBytes(20)); }
export function totpCode(secret, timestamp = Date.now()) { const counter = Math.floor(timestamp / 1000 / 30); const key = base32Decode(secret); const data = Buffer.alloc(8); data.writeBigUInt64BE(BigInt(counter)); const digest = createHmac('sha1', key).update(data).digest(); const offset = digest[digest.length - 1] & 0x0f; const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset+1] & 0xff) << 16) | ((digest[offset+2] & 0xff) << 8) | (digest[offset+3] & 0xff); return String(binary % 1_000_000).padStart(6,'0'); }
export function verifyTotp(secret, code, timestamp = Date.now()) { const supplied=String(code||'').replace(/\s/g,''); if(!/^\d{6}$/.test(supplied)) return false; for(let drift=-1; drift<=1; drift++) { if(timingSafeEqual(Buffer.from(totpCode(secret, timestamp + drift*30_000)), Buffer.from(supplied))) return true; } return false; }
export function encryptSecret(value) { const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm', encryptionKey, iv); const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]); return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`; }
export function decryptSecret(value) { const [ivB64,tagB64,dataB64]=String(value||'').split('.'); if(!ivB64||!tagB64||!dataB64) throw new Error('Invalid encrypted secret'); const decipher=createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivB64,'base64url')); decipher.setAuthTag(Buffer.from(tagB64,'base64url')); return Buffer.concat([decipher.update(Buffer.from(dataB64,'base64url')),decipher.final()]).toString('utf8'); }
export function signMfaChallenge(user, ttlSeconds = 300) { const now=Math.floor(Date.now()/1000); const head=b64(JSON.stringify({alg:'HS256',typ:'JWT'})); const body=b64(JSON.stringify({sub:user.id,email:user.email,iat:now,exp:now+ttlSeconds,purpose:'mfa-challenge',jti:randomToken(12)})); const input=`${head}.${body}`; return `${input}.${signature(input)}`; }
export function verifyMfaChallenge(token) { const claims=verifyToken(token); return claims?.purpose === 'mfa-challenge' ? claims : null; }

export function signToken(user, ttlSeconds = 900) { const now = Math.floor(Date.now() / 1000); const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const body = b64(JSON.stringify({ sub: user.id, email: user.email, iat: now, exp: now + ttlSeconds, jti: randomToken(12) })); const input = `${head}.${body}`; return `${input}.${signature(input)}`; }
export function verifyToken(token) { const parts = String(token || '').split('.'); if (parts.length !== 3) return null; const input = `${parts[0]}.${parts[1]}`; const expected = Buffer.from(signature(input)); const actual = Buffer.from(parts[2]); if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null; try { const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); if (!payload.sub || payload.exp <= Math.floor(Date.now() / 1000)) return null; return payload; } catch { return null; } }
