import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

// "로그인 유지"를 고르면 오래, 고르지 않으면 짧게 유지한다.
const SESSION_SECONDS = { remember: 90 * 24 * 3600, short: 12 * 3600 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(db, user, remember) {
  const token = randomBytes(32).toString('hex');
  const maxAge = remember ? SESSION_SECONDS.remember : SESSION_SECONDS.short;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), user.id, Date.now() + maxAge * 1000);
  return { token, maxAge, remember: Boolean(remember) };
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, username: row.username };
}

export function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyOtherSessions(db, userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken));
}
