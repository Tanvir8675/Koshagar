// build.mjs — Produce an obfuscated, deploy-ready copy of the app in dist/.
//
// What it does:
//   * Obfuscates every external JS file (calc/, db/, ui/, modules/, app.js).
//   * Obfuscates the inline <script> blocks inside index.html (the engine/shell)
//     while leaving the HTML and the <script src> tags intact.
//   * Obfuscates service-worker.js.
//   * Copies manifest + icons.
//   * Does NOT copy readable source you don't deploy (index_test.html, backups,
//     build files, node_modules).
//
// IMPORTANT:
//   - You keep editing the readable source in the project root. Only dist/ is
//     deployed. Run `npm run build` after changes, then deploy dist/.
//   - Obfuscation is a DETERRENT, not a lock — client code can still be reverse
//     engineered, and your data still lives in the browser's IndexedDB.
//   - Settings are CONSERVATIVE on purpose (this is financial code). Global names
//     are preserved (renameGlobals:false) because the app calls global functions
//     from onclick="..." attributes and across files — renaming them would break
//     everything. controlFlowFlattening / deadCodeInjection are OFF to avoid
//     subtle bugs and runtime slowdown. ALWAYS test dist/ before deploying.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const OBFUSCATE_OPTS = {
  target: 'browser',
  compact: true,
  renameGlobals: false,            // CRITICAL: keep global function names (onclick + cross-file calls)
  identifierNamesGenerator: 'mangled',
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  splitStrings: false,
  transformObjectKeys: false,      // keep object property names (e.g. KoshCalc.computeFinancialSnapshot)
  controlFlowFlattening: false,    // conservative: avoid subtle bugs in financial logic
  deadCodeInjection: false,
  numbersToExpressions: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false
};

// Every obfuscated unit (each external file AND each inline <script> block) shares
// ONE global scope because they're classic scripts. With mangled names restarting
// at a,b,c… per file, the obfuscator's own injected helpers (string-array variable
// + decoder function) collide across files — the decoder then reads the wrong array,
// hits `undefined`, and throws "Cannot read properties of undefined (reading
// 'charAt')", breaking the whole app. Giving each unit a UNIQUE identifiersPrefix
// namespaces those generated helpers so they can't clash. (App globals stay
// untouched — renameGlobals:false — so cross-file/onclick calls still work.)
let __obfSeq = 0;
const obf = (code) => JavaScriptObfuscator
  .obfuscate(code, { ...OBFUSCATE_OPTS, identifiersPrefix: `_ko${__obfSeq++}_` })
  .getObfuscatedCode();

// WHAT TO SHIP IS READ FROM index.html, NOT LISTED HERE.
//
// This used to be a hand-written list, and it had gone out of date in the worst
// possible way: the five files of the Supabase layer - data/supabase-api.js,
// data/auth.js, data/load-shop.js, data/write-shop.js and data/server-totals.js
// - were added to index.html and never added here. The build succeeded, said
// nothing, and produced a dist/ whose index.html asks for five scripts that are
// not in the folder. Deployed, that is an app which cannot sign in, cannot read
// a shop and cannot write a document - and no line of the build output would
// have hinted at it.
//
// A list that has to be kept in step with another list eventually will not be.
// So the page itself is the list: every <script src> in index.html is shipped,
// and the check at the end of run() refuses to call it a build if one of them
// did not make it into dist/.
async function scriptsFrom(htmlPath) {
  const html = await fs.readFile(htmlPath, 'utf8');
  const found = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1].replace(/^\.\//, '');
    if (/^(https?:)?\/\//.test(src)) continue;   // not ours to obfuscate
    if (src.startsWith('vendor/')) continue;     // third-party, copied verbatim
    if (!found.includes(src)) found.push(src);
  }
  return found;
}

async function writeOut(rel, content) {
  const dest = path.join(DIST, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
}

async function run() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  // 1) External JS modules - exactly the ones index.html asks for.
  const JS_FILES = await scriptsFrom(path.join(ROOT, 'index.html'));
  console.log(`index.html asks for ${JS_FILES.length} script file(s)`);
  for (const rel of JS_FILES) {
    const src = await fs.readFile(path.join(ROOT, rel), 'utf8');
    await writeOut(rel, obf(src));
    console.log('obfuscated', rel);
  }

  // 2) Service worker
  const sw = await fs.readFile(path.join(ROOT, 'service-worker.js'), 'utf8');
  await writeOut('service-worker.js', obf(sw));
  console.log('obfuscated service-worker.js');

  // 3) index.html — obfuscate inline <script> blocks; keep HTML + <script src> tags.
  // (External script tags are "<script src=...>" so they don't match "<script>".)
  let html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  let inlineCount = 0;
  html = html.replace(/<script>([\s\S]*?)<\/script>/g, (m, code) => {
    if (!code.trim()) return m;
    try {
      inlineCount++;
      return '<script>' + obf(code) + '</script>';
    } catch (e) {
      console.warn('  ! inline <script> obfuscation failed, leaving readable:', e.message);
      return m;
    }
  });
  await writeOut('index.html', html);
  console.log(`obfuscated index.html (${inlineCount} inline script block(s))`);

  // 4) Static assets
  try {
    await fs.copyFile(path.join(ROOT, 'manifest.webmanifest'), path.join(DIST, 'manifest.webmanifest'));
    console.log('copied manifest.webmanifest');
  } catch (_) {}
  try {
    const icons = await fs.readdir(path.join(ROOT, 'icons'));
    await fs.mkdir(path.join(DIST, 'icons'), { recursive: true });
    for (const f of icons) await fs.copyFile(path.join(ROOT, 'icons', f), path.join(DIST, 'icons', f));
    console.log(`copied icons/ (${icons.length} file(s))`);
  } catch (_) {}
  // Self-hosted sql.js (third-party lib + WASM) — copied verbatim, NOT obfuscated.
  try {
    const vendor = await fs.readdir(path.join(ROOT, 'vendor'));
    await fs.mkdir(path.join(DIST, 'vendor'), { recursive: true });
    for (const f of vendor) await fs.copyFile(path.join(ROOT, 'vendor', f), path.join(DIST, 'vendor', f));
    console.log(`copied vendor/ (${vendor.length} file(s))`);
  } catch (_) {}

  // 5) Refuse to call it a build if the page would 404 on its own code.
  const missing = [];
  for (const rel of JS_FILES) {
    try { await fs.access(path.join(DIST, rel)); }
    catch (_) { missing.push(rel); }
  }
  if (missing.length) {
    console.error('\nBUILD INCOMPLETE - index.html loads these and they are not in dist/:');
    missing.forEach((f) => console.error('   ' + f));
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Build complete → frontend/dist/');
  console.log('   Deploy the frontend/dist/ folder (firebase.json public is set to "frontend/dist").');
  console.log('   Always test frontend/dist/ locally before deploying.');
}

run().catch((e) => { console.error(e); process.exit(1); });
