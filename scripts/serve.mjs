import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
createServer(async (request, response) => {
  const requestPath = request.url === '/' ? '/index.html' : request.url;
  const file = path.resolve(root, `.${requestPath.split('?')[0]}`);
  if (!file.startsWith(root)) return response.writeHead(403).end('Forbidden');
  try { const contents = await readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'text/plain' }); response.end(contents); }
  catch { response.writeHead(404).end('Not found'); }
}).listen(4173, () => console.log('Open http://localhost:4173'));
