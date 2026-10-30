import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { userFromToken } from './auth.js';
import { buildRoutes, HttpError } from './api.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MAX_BODY = 1024 * 1024;

function compile(routes) {
  return routes.map((r) => ({
    ...r,
    regex: new RegExp(`^${r.path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
  }));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, '요청이 너무 큽니다');
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'JSON만 받을 수 있습니다');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 형식이 올바르지 않습니다');
  }
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(payload);
}

export function createApp(db, { secureCookie = false } = {}) {
  const routes = compile(buildRoutes(db));
  const attempts = new Map(); // 로그인 시도 제한: 아이디+IP 기준 10분에 8회

  function rateLimit(key) {
    const now = Date.now();
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= 8) throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요');
    recent.push(now);
    attempts.set(key, recent);
  }

  const cookie = (value, maxAge) =>
    `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

  async function handleApi(req, res, url) {
    const route = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
    if (!route) throw new HttpError(404, '찾을 수 없습니다');
    const token = parseCookies(req.headers.cookie).sid;
    const user = userFromToken(db, token);
    if (route.access !== 'public' && !user) throw new HttpError(401, '로그인이 필요합니다');
    if (route.access === 'pharmacist' && user.role !== 'pharmacist') throw new HttpError(403, '권한이 없습니다');

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    const ip = req.socket.remoteAddress;
    const result = route.handler({
      user, token, body,
      params: url.pathname.match(route.regex).groups ?? {},
      query: url.searchParams,
      rateLimit: (name) => rateLimit(`${ip}|${name}`),
    });
    const headers = {};
    if (result.session) headers['Set-Cookie'] = cookie(result.session.token, result.session.maxAge);
    if (result.clearSession) headers['Set-Cookie'] = cookie('', 0);
    sendJson(res, result.status ?? 200, result.body, headers);
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = join(PUBLIC_DIR, normalize(rel));
    if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, '찾을 수 없습니다');
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(data);
    } catch {
      throw new HttpError(404, '찾을 수 없습니다');
    }
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET') await serveStatic(res, url.pathname);
      else throw new HttpError(404, '찾을 수 없습니다');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      sendJson(res, e.status ?? 500, { error: e instanceof HttpError ? e.message : '서버 오류가 발생했습니다' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  // 기본은 이 PC에서만 접속. 약국 Wi-Fi의 폰에서도 쓰려면 HOST=0.0.0.0
  const host = process.env.HOST ?? '127.0.0.1';
  const db = openDb(process.env.DB_PATH ?? 'data/pharmacy.db');
  createApp(db, { secureCookie: process.env.SECURE_COOKIE === '1' }).listen(port, host, () => {
    console.log(`푸른약국 장부: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}
