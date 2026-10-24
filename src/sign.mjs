import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { home, sha256 } from './util.mjs';

// Receipts are in-toto statements in a DSSE envelope, signed with this machine's Ed25519 key.
export const PAYLOAD_TYPE = 'application/vnd.in-toto+json';

// DSSE pre-authentication encoding: what actually gets signed.
export function pae(type, body) {
  const t = Buffer.from(type, 'utf8');
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `), t, Buffer.from(` ${body.length} `), body]);
}

const keyFiles = () => {
  const dir = path.join(home(), 'keys');
  return { dir, priv: path.join(dir, 'ed25519.key.pem'), pub: path.join(dir, 'ed25519.pub.pem') };
};

export const keyIdOf = (publicKey) => sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);

export function ensureKey() {
  const k = keyFiles();
  if (!fs.existsSync(k.priv)) {
    fs.mkdirSync(k.dir, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(k.priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(k.pub, publicKey.export({ type: 'spki', format: 'pem' }));
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(k.priv));
  const publicKey = crypto.createPublicKey(fs.readFileSync(k.pub));
  return { privateKey, publicKey, keyid: keyIdOf(publicKey), pubFile: k.pub };
}

// This machine's key plus any public keys copied into ~/.receipts/trusted/.
export function trustedKeys() {
  const keys = new Map();
  const add = (file) => {
    try {
      const key = crypto.createPublicKey(fs.readFileSync(file));
      keys.set(keyIdOf(key), { key, file });
    } catch {
      // not a public key file
    }
  };
  const k = keyFiles();
  if (fs.existsSync(k.pub)) add(k.pub);
  const trusted = path.join(home(), 'trusted');
  if (fs.existsSync(trusted)) for (const f of fs.readdirSync(trusted)) if (f.endsWith('.pem')) add(path.join(trusted, f));
  return keys;
}

export function signStatement(statement, key) {
  const payload = Buffer.from(JSON.stringify(statement), 'utf8');
  const sig = crypto.sign(null, pae(PAYLOAD_TYPE, payload), key.privateKey);
  return {
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString('base64'),
    signatures: [{ keyid: key.keyid, sig: sig.toString('base64') }],
  };
}

export function openEnvelope(envelope, keys = trustedKeys()) {
  if (envelope?.payloadType !== PAYLOAD_TYPE || typeof envelope.payload !== 'string') {
    return { ok: false, reason: 'not an in-toto DSSE envelope' };
  }
  const payload = Buffer.from(envelope.payload, 'base64');
  for (const s of envelope.signatures || []) {
    const k = keys.get(s.keyid);
    if (!k) continue;
    if (!crypto.verify(null, pae(envelope.payloadType, payload), k.key, Buffer.from(s.sig, 'base64'))) {
      return { ok: false, reason: `signature does not match (key ${s.keyid}): the receipt was edited` };
    }
    return { ok: true, keyid: s.keyid, statement: JSON.parse(payload.toString('utf8')) };
  }
  return { ok: false, reason: 'not signed by a trusted key' };
}
