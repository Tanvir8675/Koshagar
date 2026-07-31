const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(process.cwd(), 'frontend', 'dist');
const requestedPort = Number(process.env.PORT || 3000);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
  console.log(`Frontend Local:   http://localhost:${requestedPort}`);
  getLanUrls(requestedPort).forEach(url => console.log(`Frontend Network: ${url}`));
});
