// Minimal static file server for Playwright tests — serves web/ directory only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const mimeTypes = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
};

const webDir = path.join(__dirname, '..', 'web');

const server = http.createServer((req, res) => {
  const filePath = path.join(webDir, req.url === '/' ? 'index.html' : req.url);
  // Prevent path traversal outside web/
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403); res.end(); return;
  }
  try {
    const ext = path.extname(filePath);
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end();
  }
});

const port = parseInt(process.argv[2] || '3099');
server.listen(port, () => process.stdout.write(`Test server on ${port}\n`));
