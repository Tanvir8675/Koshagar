// local-dev-server.cjs — serve the READABLE source in frontend/ for local testing.
//
// Why this exists:
//   tools/local-static-server.cjs serves frontend/dist (the obfuscated build), so
//   testing a source change there means running `npm run build` first and then
//   debugging minified code. This serves frontend/ directly, so an edit is live on
//   reload with readable stack traces.
//
//   Deploying is unchanged: `npm run build` still produces frontend/dist, and that
//   is still the only thing that ever gets deployed.
//
// Usage:  npm run dev        (defaults to port 3100)
//         PORT=4000 npm run dev

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(process.cwd(), 'frontend');
const requestedPort = Number(process.env.PORT || 3100);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm'
};

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
  // Never cache in dev — a stale index.html or module is the classic "my change
  // did nothing" bug, made worse here by the app's own service worker.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  fs.createReadStream(filePath).on('error', () => {
    res.statusCode = 404;
    res.end('Not found');
  }).pipe(res);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.normalize(path.join(root, urlPath));

  if (!filePath.startsWith(root)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  if (urlPath === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(root, 'index.html');
  }

  sendFile(res, filePath);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${requestedPort} is already in use. Open http://localhost:${requestedPort} or stop the old process first.`);
    process.exit(1);
  }
  throw error;
});

function getLanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .filter(addr => addr.family === 'IPv4' && !addr.internal)
    .map(addr => `http://${addr.address}:${port}`);
}

server.listen(requestedPort, '0.0.0.0', () => {
  console.log('');
  console.log('  DEV MODE — serving readable source from frontend/');
  console.log(`  Local:   http://localhost:${requestedPort}`);
  getLanUrls(requestedPort).forEach(url => console.log(`  Network: ${url}`));
  console.log('');
  console.log('  Log in with a TEST user id (e.g. tasmim007dev), never the real one —');
  console.log('  this build talks to the same Firestore project as the live app.');
  console.log('');
});
