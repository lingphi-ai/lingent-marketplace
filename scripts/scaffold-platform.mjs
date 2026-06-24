#!/usr/bin/env node
// scaffold-platform.mjs — Playwright session-bridge platform scaffolder.
//
// An AUTHORING tool you (the maintainer) run against your OWN logged-in browser
// session to generate a DRAFT session-bridge manifest for the Lingent
// marketplace. It opens a real Chromium window with a persistent profile, lets
// you log in once and click around (search, open an issue, list PRs…), captures
// the same-host JSON/API XHR+fetch traffic the page makes, then distills those
// requests into a draft `<id>.lingphi-platform.json` HttpPlatformManifest that
// uses the cookie + content-script "session bridge" pattern (auth:{type:'cookie'},
// transport:{preferred:'cs'}) — the same shape as the jira-cloud / sharepoint
// packs.
//
// The output is a DRAFT: tool names/descriptions and params are heuristic
// guesses. You review, rename, test in the extension, then sign + publish. The
// scaffolder never signs and never pushes.
//
// USAGE
//   node scripts/scaffold-platform.mjs --url <startUrl> --id <slug> \
//        --name <DisplayName> --hosts <glob[,glob]>
//
//   # Example (Gitee):
//   node scripts/scaffold-platform.mjs \
//     --url https://gitee.com --id gitee --name Gitee --hosts "gitee.com/*"
//
// FLAGS
//   --url     Start URL to open (required).
//   --id      Platform slug, e.g. "gitee" (required). Used for filename + tool prefix.
//   --name    Display name, e.g. "Gitee" (required).
//   --hosts   Comma-separated URL globs the platform owns (required),
//             e.g. "gitee.com/*,*.gitee.com/*". Normalised to "https://<glob>".
//   --out     Output path (default: packs/<id>.lingphi-platform.json).
//   --profile Persistent user-data dir (default: .scaffold-profile/<id>).
//   --auto-close-ms <n>  TEST/CI mode: don't prompt; auto-generate after <n> ms
//                        of capturing. Lets a headless dry-run prove the capture
//                        mechanics against a public page. Implies --headless.
//   --headless           Run headless (default: headed, so you can log in).
//   --help               Print this help and exit 0.
//
// REQUIREMENTS
//   npm install            # installs the `playwright` devDependency
//   npx playwright install chromium   # one-time browser download
//
// This file declares `playwright` as a devDependency but lazy-imports it, so
// `--help` works even before the browser/package is installed.

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { createInterface } from 'readline'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { args.help = true; continue }
    if (a === '--headless') { args.headless = true; continue }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      // value-less boolean flags are handled above; everything else takes a value
      if (next === undefined || next.startsWith('--')) { args[key] = true }
      else { args[key] = next; i++ }
    }
  }
  return args
}

const USAGE = `
scaffold-platform — generate a DRAFT session-bridge platform manifest by
capturing the API traffic of your own logged-in browser session.

Usage:
  node scripts/scaffold-platform.mjs --url <startUrl> --id <slug> \\
       --name <DisplayName> --hosts <glob[,glob]>

Required:
  --url     Start URL to open (e.g. https://gitee.com)
  --id      Platform slug (e.g. gitee) — used for filename + tool prefix
  --name    Display name (e.g. Gitee)
  --hosts   Comma-separated URL globs (e.g. "gitee.com/*,*.gitee.com/*")

Optional:
  --out <path>          Output manifest path (default packs/<id>.lingphi-platform.json)
  --profile <dir>       Persistent profile dir (default .scaffold-profile/<id>)
  --headless            Run headless (default: headed so you can log in)
  --auto-close-ms <n>   CI/test mode: skip the prompt, auto-generate after n ms
                        (implies --headless). For a no-login dry-run.
  --help                Show this help

Example (Gitee):
  node scripts/scaffold-platform.mjs \\
    --url https://gitee.com --id gitee --name Gitee --hosts "gitee.com/*"

First-time setup:
  npm install
  npx playwright install chromium
`

// ────────────────────────────────────────────────────────────────────────────
// Heuristics
// ────────────────────────────────────────────────────────────────────────────

// Static asset / non-API extensions we never treat as a "tool" call.
const STATIC_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|mp4|webm|avif|wasm)(\?|$)/i

// Resource types Playwright labels as non-API.
const SKIP_RESOURCE_TYPES = new Set([
  'image', 'stylesheet', 'font', 'media', 'script', 'manifest', 'texttrack', 'websocket', 'eventsource',
])

// Header names that look auth/CSRF-ish — worth surfacing for the session bridge.
const INTERESTING_HEADER = /^(x-csrf|x-xsrf|x-requested-with|x-api|x-auth|authorization|x-gitee|x-pjax)/i

// Convert a glob like "gitee.com/*" into "https://gitee.com/*" so Playwright
// route/host matching and the manifest `hosts` field are scheme-qualified.
function normaliseHostGlob(g) {
  const t = g.trim()
  if (!t) return null
  if (/^https?:\/\//i.test(t)) return t
  return `https://${t}`
}

// Strip a host glob down to the bare hostname pattern for same-host filtering,
// e.g. "https://gitee.com/*" -> "gitee.com", "*.gitee.com/*" -> "*.gitee.com".
function hostPatternOf(glob) {
  return glob.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
}

// Does a request URL's host match any of the configured host patterns?
// Supports a leading "*." wildcard.
function hostMatches(urlHost, patterns) {
  return patterns.some((p) => {
    if (p.startsWith('*.')) {
      const base = p.slice(2)
      return urlHost === base || urlHost.endsWith(`.${base}`)
    }
    return urlHost === p
  })
}

// Does this request look like a JSON/REST API call worth turning into a tool?
function looksLikeApi(url, resourceType, reqHeaders, contentType) {
  if (SKIP_RESOURCE_TYPES.has(resourceType)) return false
  if (STATIC_EXT.test(url)) return false
  const accept = (reqHeaders['accept'] || '').toLowerCase()
  const xrw = (reqHeaders['x-requested-with'] || '').toLowerCase()
  const ct = (contentType || '').toLowerCase()
  if (accept.includes('application/json')) return true
  if (ct.includes('application/json')) return true
  if (xrw === 'xmlhttprequest') return true
  // Path-based fallback: REST-y prefixes.
  if (/\/(api|graphql|v\d+)(\/|$|\?)/i.test(url)) return true
  // Playwright marks programmatic fetch/xhr as 'xhr'/'fetch'.
  return resourceType === 'xhr' || resourceType === 'fetch'
}

// Collapse numeric / id-looking path segments into {param} placeholders so that
// /api/v5/repos/foo/issues/123 and /456 dedupe to one template, and give each
// collapsed segment a name inferred from the PRECEDING segment.
//   /repos/{owner}/issues/{number}  (singularised noun + sensible fallbacks)
function templatize(pathname) {
  const segs = pathname.split('/')
  const params = []
  const out = segs.map((seg, i) => {
    if (seg === '') return seg
    const isId =
      /^\d+$/.test(seg) ||                       // pure number
      /^[0-9a-f]{8,}$/i.test(seg) ||             // long hex / sha
      /^[0-9a-fA-F-]{16,}$/.test(seg)            // uuid-ish
    if (!isId) return seg
    const prev = segs[i - 1] || 'item'
    let name = singular(prev)
    // Disambiguate duplicate param names within one path.
    let n = name, k = 2
    while (params.includes(n)) { n = `${name}${k++}` }
    name = n
    params.push(name)
    return `{${name}}`
  })
  return { template: out.join('/'), pathParams: params }
}

function singular(word) {
  const w = word.toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (!w) return 'id'
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y_id`
  if (w.endsWith('ses')) return `${w.slice(0, -2)}_id`
  if (w.endsWith('s')) return `${w.slice(0, -1)}_id`
  return `${w}_id`
}

// Generate a tool name from method + path template, e.g.
//   GET /api/v5/user/repos -> gitee_list_user_repos
//   GET /api/v5/repos/{owner_id}/issues/{issue_id} -> gitee_get_repos_owner_issue
function toolNameFor(idSlug, method, template) {
  const verb = ({ GET: 'get', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' })[method] || method.toLowerCase()
  // Use the last 2-3 meaningful (non-param, non-version, non-api) segments.
  const meaningful = template
    .split('/')
    .filter((s) => s && !s.startsWith('{') && !/^(api|v\d+|rest)$/i.test(s))
    .map((s) => s.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase())
  const tail = meaningful.slice(-3).join('_') || 'resource'
  // For collection GETs ending in a plural noun, prefer "list".
  const lastSeg = template.split('/').filter(Boolean).pop() || ''
  const isCollection = method === 'GET' && !lastSeg.startsWith('{') && /s$/.test(lastSeg)
  const finalVerb = method === 'GET' && isCollection ? 'list' : verb
  return `${idSlug}_${finalVerb}_${tail}`.replace(/_+/g, '_').replace(/_$/, '')
}

// Infer body params from a captured request post body (JSON object → one param
// per top-level key; otherwise a single opaque 'body' object param).
function bodyParamsFrom(postData, contentType) {
  if (!postData) return []
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('application/json')) {
    try {
      const obj = JSON.parse(postData)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return Object.keys(obj).map((k) => ({
          name: k,
          in: 'body',
          type: typeof obj[k] === 'number' ? 'number'
            : typeof obj[k] === 'boolean' ? 'boolean'
            : typeof obj[k] === 'object' ? 'object' : 'string',
          // TODO: confirm which body fields are required.
        }))
      }
    } catch { /* fall through */ }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    try {
      const params = new URLSearchParams(postData)
      return [...params.keys()].map((k) => ({ name: k, in: 'body', type: 'string' }))
    } catch { /* ignore */ }
  }
  // Opaque body — one object param the author can refine.
  return [{ name: 'body', in: 'body', type: 'object', description: 'TODO: define request body shape (captured but not JSON).' }]
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || (!args.url && !args.id && !args.name && !args.hosts)) {
    console.log(USAGE)
    process.exit(0)
  }

  const missing = ['url', 'id', 'name', 'hosts'].filter((k) => !args[k] || args[k] === true)
  if (missing.length) {
    console.error(`Error: missing required arg(s): ${missing.map((m) => `--${m}`).join(', ')}`)
    console.error(USAGE)
    process.exit(2)
  }

  const idSlug = String(args.id).replace(/[^a-z0-9_-]/gi, '').toLowerCase()
  const displayName = String(args.name)
  const startUrl = String(args.url)
  const hostGlobs = String(args.hosts).split(',').map(normaliseHostGlob).filter(Boolean)
  const hostPatterns = hostGlobs.map(hostPatternOf)
  const outPath = resolve(ROOT, args.out ? String(args.out) : join('packs', `${idSlug}.lingphi-platform.json`))
  const profileDir = resolve(ROOT, args.profile ? String(args.profile) : join('.scaffold-profile', idSlug))
  const autoCloseMs = args['auto-close-ms'] ? Number(args['auto-close-ms']) : 0
  const headless = !!args.headless || autoCloseMs > 0

  // Lazy-import Playwright so --help works without it installed.
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    console.error('\nPlaywright is not installed. Run:\n  npm install\n  npx playwright install chromium\n')
    process.exit(127)
  }

  mkdirSync(profileDir, { recursive: true })
  console.log(`\nLaunching Chromium (${headless ? 'headless' : 'headed'}) with persistent profile:\n  ${profileDir}`)
  console.log(`Host filter: ${hostPatterns.join(', ')}\n`)

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
  })

  // captured: keyed by `${method} ${template}` so we naturally dedupe.
  const captured = new Map()
  const csrfHints = { meta: null, cookie: null }

  // Network listener — inspect each finished request/response pair.
  context.on('requestfinished', async (request) => {
    try {
      const url = request.url()
      let u
      try { u = new URL(url) } catch { return }
      if (!hostMatches(u.host, hostPatterns)) return

      const resourceType = request.resourceType()
      const reqHeadersRaw = await request.allHeaders().catch(() => ({}))
      const reqHeaders = Object.fromEntries(Object.entries(reqHeadersRaw).map(([k, v]) => [k.toLowerCase(), v]))
      const response = await request.response().catch(() => null)
      const respHeaders = response ? await response.allHeaders().catch(() => ({})) : {}
      const respCt = (respHeaders['content-type'] || '').toLowerCase()

      if (!looksLikeApi(url, resourceType, reqHeaders, respCt)) return

      const method = request.method().toUpperCase()
      const { template, pathParams } = templatize(u.pathname)
      const key = `${method} ${template}`

      // Capture interesting (auth/csrf) headers seen on this endpoint.
      const interesting = {}
      for (const [k, v] of Object.entries(reqHeaders)) {
        if (INTERESTING_HEADER.test(k)) interesting[k] = v
      }

      // Note CSRF-ish header names globally so we can emit a csrf spec.
      for (const k of Object.keys(interesting)) {
        if (/x-csrf|x-xsrf/i.test(k) && !csrfHints._headerName) csrfHints._headerName = k
      }

      const queryKeys = [...u.searchParams.keys()]
      const postData = request.postData()
      const reqCt = reqHeaders['content-type'] || ''

      let respSample = ''
      if (response && respCt.includes('json')) {
        const body = await response.text().catch(() => '')
        respSample = body.slice(0, 400)
      }

      if (!captured.has(key)) {
        captured.set(key, {
          method,
          template,
          baseUrl: `${u.protocol}//${u.host}`,
          pathParams,
          queryKeys: new Set(queryKeys),
          interestingHeaders: interesting,
          postData,
          reqContentType: reqCt,
          respSample,
          count: 1,
          sampleUrl: url,
        })
        process.stdout.write(`  captured  ${method} ${template}\n`)
      } else {
        const ex = captured.get(key)
        ex.count++
        queryKeys.forEach((q) => ex.queryKeys.add(q))
        if (!ex.postData && postData) { ex.postData = postData; ex.reqContentType = reqCt }
        Object.assign(ex.interestingHeaders, interesting)
      }
    } catch {
      /* never let a listener error crash the run */
    }
  })

  const page = context.pages()[0] || await context.newPage()
  console.log(`Navigating to ${startUrl} …`)
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch((e) => {
    console.warn(`  (navigation warning: ${e.message})`)
  })

  // Detect CSRF source from the page after load.
  await detectCsrf(page, csrfHints).catch(() => {})

  if (autoCloseMs > 0) {
    console.log(`\n[auto-close] capturing for ${autoCloseMs} ms (CI/dry-run mode)…`)
    await page.waitForTimeout(autoCloseMs)
  } else {
    console.log(`
────────────────────────────────────────────────────────────────────────────
A Chromium window is open with a persistent profile.

  1. Log in to ${displayName} if you are not already.
  2. Perform the actions you want to become TOOLS:
       search, open an issue, list pull requests, view a file, etc.
     Each distinct API call the page makes is captured (deduped).
  3. Come back here and press ENTER to generate the draft manifest.
────────────────────────────────────────────────────────────────────────────
`)
    await waitForEnter()
    // Re-scan CSRF in case it appeared after login.
    await detectCsrf(page, csrfHints).catch(() => {})
  }

  // ── Build the manifest ────────────────────────────────────────────────────
  const tools = []
  // Stable ordering: GETs first, then by path.
  const entries = [...captured.values()].sort((a, b) => {
    if (a.method !== b.method) return a.method === 'GET' ? -1 : b.method === 'GET' ? 1 : a.method.localeCompare(b.method)
    return a.template.localeCompare(b.template)
  })

  // Choose the most common API origin as baseUrl; strip a common API prefix
  // (e.g. "/api/v5") into baseUrl so tool paths stay short.
  const apiOrigin = entries[0]?.baseUrl || hostGlobs[0].replace(/\/\*?$/, '')
  const commonPrefix = longestCommonApiPrefix(entries.map((e) => e.template))
  const baseUrl = commonPrefix ? `${apiOrigin}${commonPrefix}` : apiOrigin

  for (const e of entries) {
    const relPath = commonPrefix && e.template.startsWith(commonPrefix)
      ? e.template.slice(commonPrefix.length) || '/'
      : e.template
    const params = []
    for (const p of e.pathParams) {
      params.push({ name: p, in: 'path', type: 'string', required: true, description: 'TODO: describe' })
    }
    for (const q of e.queryKeys) {
      params.push({ name: q, in: 'query', type: 'string', description: 'TODO: describe / set default' })
    }
    if (e.method !== 'GET') {
      params.push(...bodyParamsFrom(e.postData, e.reqContentType))
    }
    const tool = {
      name: toolNameFor(idSlug, e.method, e.template),
      description: `TODO: describe what this does. Captured ${e.count}× from ${e.sampleUrl}`,
      method: e.method,
      path: relPath.startsWith('/') ? relPath : `/${relPath}`,
      ...(params.length ? { params } : {}),
      responseType: 'json',
    }
    if (e.method !== 'GET') tool.requiresApproval = true
    if (e.respSample) tool._responseSample = e.respSample // _-prefixed: ignored by schema, helps the author
    tools.push(tool)
  }

  const auth = { type: 'cookie' }
  if (csrfHints.meta) {
    auth.csrf = { source: 'meta', name: csrfHints.meta.name, headerName: csrfHints._headerName || 'X-CSRF-Token' }
  } else if (csrfHints.cookie) {
    auth.csrf = { source: 'cookie', name: csrfHints.cookie, headerName: csrfHints._headerName || 'X-CSRF-Token' }
  }

  const manifest = {
    id: `${idSlug}-manifest`,
    version: '0.1.0',
    displayName,
    description: `TODO: one-line description. ${displayName} via the session cookie of an open ${displayName} tab (session bridge). DRAFT generated by scaffold-platform — endpoints, names, and params are heuristic guesses; review before signing.`,
    iconColor: 'bg-gray-100 text-gray-700',
    category: 'development',
    hosts: hostGlobs,
    baseUrl,
    auth,
    transport: { preferred: 'cs' },
    credentialFields: [],
    tools,
    retry: { maxAttempts: 3, respectRetryAfter: true },
    timeoutMs: 30000,
    _draft: {
      generatedBy: 'scaffold-platform.mjs',
      generatedAt: new Date().toISOString(),
      note: 'Unsigned draft. Review tool names/descriptions/params, test in the extension, then run scripts/sign-packs.mjs. _-prefixed fields (_draft, _responseSample) are author hints and are ignored by the manifest schema/compiler.',
      csrfDetected: auth.csrf ? auth.csrf : 'none — inspect requests; some sites need no CSRF for GETs or use a different mechanism',
    },
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')

  await context.close()

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n✓ Wrote DRAFT manifest: ${outPath}`)
  console.log(`  ${tools.length} tool(s) from ${captured.size} unique endpoint(s).`)
  if (!auth.csrf) {
    console.log('  ⚠ No CSRF source auto-detected. If write tools fail with 403, inspect')
    console.log('    request headers and add an auth.csrf block (see jira-cloud pack).')
  }
  console.log(`
────────────────────────────  NEXT STEPS  ────────────────────────────────────
  1. REVIEW the draft: open ${outPath}
       • rename each tool to a clear verb_noun (e.g. ${idSlug}_search_repos)
       • write a real description for every tool (the agent reads these!)
       • mark required params, set sensible query defaults, drop noise endpoints
       • delete the _draft / _responseSample author-hint fields when done
  2. TEST in the extension (load unpacked dist/, then install via a LOCAL
     manifest URL or paste): open a logged-in ${displayName} tab and invoke a
     tool. Fix paths/params until it returns real data.
  3. SIGN:    node scripts/sign-packs.mjs
  4. CATALOG: add an entry to catalog.json under the right category with a
     manifestUrl pointing at the raw pack URL.
  5. COMMIT + push (signing key stays in CI; do not commit keys/signing-private.pem).
───────────────────────────────────────────────────────────────────────────────
`)
}

// Find the longest leading path prefix shared by ALL templates that is a clean
// API base (e.g. "/api/v5"). Returns '' if there is none meaningful.
function longestCommonApiPrefix(templates) {
  if (templates.length === 0) return ''
  const split = templates.map((t) => t.split('/').filter(Boolean))
  const first = split[0]
  let prefix = []
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]
    if (seg.startsWith('{')) break
    if (!split.every((s) => s[i] === seg)) break
    prefix.push(seg)
  }
  // Only treat it as a base if it looks API-ish and we keep at least one segment
  // of real path beyond it for every template.
  const candidate = '/' + prefix.join('/')
  if (prefix.length === 0) return ''
  const looksApi = /^\/(api|rest|v\d+|api\/v\d+)/i.test(candidate) || prefix.length >= 1
  const keepsTail = split.every((s) => s.length > prefix.length)
  return looksApi && keepsTail ? candidate : ''
}

// Scan the page for a CSRF token source: a <meta> tag first, then a CSRF-ish
// cookie. Populates the hints object in place.
async function detectCsrf(page, hints) {
  // meta[name*=csrf i] / meta[name*=xsrf i]
  const meta = await page.evaluate(() => {
    const m = document.querySelector('meta[name*="csrf" i], meta[name*="xsrf" i]')
    return m ? { name: m.getAttribute('name'), content: (m.getAttribute('content') || '').slice(0, 8) } : null
  }).catch(() => null)
  if (meta && !hints.meta) {
    hints.meta = meta
    console.log(`  CSRF source: <meta name="${meta.name}"> (content ${meta.content ? 'present' : 'empty'})`)
  }
  if (!hints.meta) {
    const cookies = await page.context().cookies().catch(() => [])
    const c = cookies.find((ck) => /csrf|xsrf/i.test(ck.name))
    if (c && !hints.cookie) {
      hints.cookie = c.name
      console.log(`  CSRF source: cookie "${c.name}"`)
    }
  }
}

function waitForEnter() {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question('', () => { rl.close(); res() })
  })
}

main().catch((err) => {
  console.error('\nscaffold-platform failed:', err)
  process.exit(1)
})
