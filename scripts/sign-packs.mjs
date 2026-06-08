// Sign every packs/*.lingphi-platform.json with the official marketplace key.
//
// Trust model: the Lingent extension bundles the matching PUBLIC key and will
// only install a `trustLevel: "verified"` pack whose signature verifies against
// it. This script is the maintainer-side counterpart.
//
//   node scripts/sign-packs.mjs            # sign all packs (generates keys on first run)
//   node scripts/sign-packs.mjs --verify   # verify existing signatures, no writes
//
// The private key (keys/signing-private.pem) is gitignored. Keep it in CI
// secrets; the committed keys/signing-public.pem is what the extension bundles.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { generateKeyPairSync, createSign, createVerify } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY_ID = 'lingphi-official-2026'
const ALGO = 'RSASSA-PKCS1-v1_5-SHA-256'
const PRIV = join(ROOT, 'keys', 'signing-private.pem')
const PUB = join(ROOT, 'keys', 'signing-public.pem')
const PACKS_DIR = join(ROOT, 'packs')

// Must byte-for-byte match the extension's signature.ts canonicalize().
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([key]) => key !== 'signature')
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function ensureKeys() {
  if (existsSync(PRIV) && existsSync(PUB)) return
  console.log('Generating RSA-2048 signing keypair…')
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  writeFileSync(PRIV, privateKey)
  writeFileSync(PUB, publicKey)
  console.log(`  wrote ${PRIV} (gitignored) and ${PUB}`)
}

const verifyOnly = process.argv.includes('--verify')
const packFiles = readdirSync(PACKS_DIR).filter((f) => f.endsWith('.lingphi-platform.json'))

if (verifyOnly) {
  const pub = readFileSync(PUB, 'utf-8')
  let failures = 0
  for (const f of packFiles) {
    const manifest = JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf-8'))
    const sig = manifest.signature
    if (!sig) { console.log(`✗ ${f}: no signature`); failures++; continue }
    const v = createVerify('RSA-SHA256')
    v.update(canonicalize(manifest))
    v.end()
    const ok = v.verify(pub, Buffer.from(sig.value, 'base64'))
    console.log(`${ok ? '✓' : '✗'} ${f} (keyId=${sig.keyId})`)
    if (!ok) failures++
  }
  process.exit(failures ? 1 : 0)
}

ensureKeys()
const priv = readFileSync(PRIV, 'utf-8')
for (const f of packFiles) {
  const path = join(PACKS_DIR, f)
  const manifest = JSON.parse(readFileSync(path, 'utf-8'))
  manifest.trustLevel = 'verified'
  delete manifest.signature
  const s = createSign('RSA-SHA256')
  s.update(canonicalize(manifest))
  s.end()
  const value = s.sign(priv).toString('base64')
  manifest.signature = { algorithm: ALGO, keyId: KEY_ID, value }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`signed ${f}`)
}
console.log('\nPublic key (bundle this in the extension trustedKeys.ts):\n')
console.log(readFileSync(PUB, 'utf-8'))
