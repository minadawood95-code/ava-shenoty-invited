import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';

const scrypt = promisify(scryptCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const port = Number(process.env.PORT || 3000);
const defaultChurchLogo = 'https://placehold.co/120x120/1C2541/D4AF37?text=%D9%84%D9%88%D8%AC%D9%88+%D8%A7%D9%84%D9%83%D9%86%D9%8A%D8%B3%D8%A9';
const defaultEventLogo = 'https://placehold.co/120x120/1C2541/FFE066?text=%D9%84%D9%88%D8%AC%D9%88+%D8%A7%D9%84%D9%81%D8%B9%D8%A7%D9%84%D9%8A%D8%A9';
const defaultVerse = 'تَعَالَوْا أَنْتُمْ مُنْفَرِدِينَ إِلَى مَوْضِعٍ خَلاَءٍ وَاسْتَرِيحُوا قَلِيلاً';
const themeNames = new Set([
  'theme-navy-gold', 'theme-burgundy-gold', 'theme-emerald-gold', 'theme-wood-parchment',
  'theme-clean-white', 'theme-neon-dark', 'theme-royal-purple', 'theme-ocean-blue',
  'theme-rose-gold', 'theme-ivory-green', 'theme-silver-black', 'theme-sky-white',
  'theme-sunset', 'theme-lavender', 'theme-christmas', 'theme-minimal-gold'
]);
const COOKIE_NAME = 'church_admin_session';
const SESSION_DAYS = 7;

const databaseUrl = process.env.DATABASE_URL || process.env.DRIZZLE_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required. Enable the managed database for this project.');
const parsedDatabaseUrl = new URL(databaseUrl);
const pool = mysql.createPool({
  host: parsedDatabaseUrl.hostname,
  port: Number(parsedDatabaseUrl.port || 3306),
  user: decodeURIComponent(parsedDatabaseUrl.username),
  password: decodeURIComponent(parsedDatabaseUrl.password),
  database: decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, '')),
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  charset: 'utf8mb4',
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  timezone: 'Z'
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sendJson = (res, status, value, extraHeaders = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(JSON.stringify(value));
};

const sendError = (res, error) => {
  if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
  console.error('Request failed:', error);
  return sendJson(res, 500, { error: 'حدث خطأ في الخادم. حاول مرة أخرى.' });
};

const readJson = async (req, limit = 8 * 1024 * 1024) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, 'حجم البيانات أكبر من المسموح.');
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'صيغة البيانات غير صحيحة.');
  }
};

const cleanText = (value, maxLength, fallback = '') => {
  const result = String(value ?? '').trim();
  if (result.length > maxLength) throw new HttpError(400, `النص أطول من الحد المسموح (${maxLength}).`);
  return result || fallback;
};

const parseThemes = (value) => {
  if (Array.isArray(value)) return value.filter((theme) => themeNames.has(theme));
  if (typeof value === 'string') {
    try { return JSON.parse(value).filter((theme) => themeNames.has(theme)); } catch { return []; }
  }
  return [];
};

const mapEvent = (row) => ({
  id: row.id,
  title: row.title,
  verse: row.verse,
  date: row.event_date,
  time: row.event_time,
  logo: row.logo,
  active: Boolean(row.active),
  themes: parseThemes(row.themes)
});

const mapTicket = (row) => ({
  code: row.code,
  name: row.name,
  stage: row.stage,
  phone: row.phone || '',
  eventId: row.event_id,
  theme: row.theme,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : ''
});

const mapAttendance = (row) => ({
  code: row.code,
  name: row.name,
  stage: row.stage,
  eventId: row.event_id,
  time: row.checked_at ? new Date(row.checked_at).toISOString() : '',
  isEarly: Boolean(row.is_early)
});

async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version VARCHAR(64) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(80) NOT NULL PRIMARY KEY,
      setting_value MEDIUMTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS church_events (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      verse TEXT NOT NULL,
      event_date VARCHAR(16) NOT NULL,
      event_time VARCHAR(80) NOT NULL,
      logo MEDIUMTEXT NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 0,
      themes JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_church_events_active (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS church_tickets (
      code VARCHAR(40) NOT NULL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      stage VARCHAR(160) NOT NULL,
      phone VARCHAR(40) NOT NULL DEFAULT '',
      event_id VARCHAR(64) NOT NULL,
      theme VARCHAR(80) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_church_tickets_event (event_id),
      CONSTRAINT fk_church_tickets_event FOREIGN KEY (event_id) REFERENCES church_events(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS church_attendance (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL,
      name VARCHAR(160) NOT NULL,
      stage VARCHAR(160) NOT NULL,
      event_id VARCHAR(64) NOT NULL,
      checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_early TINYINT(1) NOT NULL DEFAULT 0,
      UNIQUE KEY uq_church_attendance_code (code),
      INDEX idx_church_attendance_event (event_id),
      CONSTRAINT fk_church_attendance_ticket FOREIGN KEY (code) REFERENCES church_tickets(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      CONSTRAINT fk_church_attendance_event FOREIGN KEY (event_id) REFERENCES church_events(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS church_admins (
      username VARCHAR(64) NOT NULL PRIMARY KEY,
      password_hash VARCHAR(160) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS church_admin_sessions (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_church_sessions_username (username),
      INDEX idx_church_sessions_expiry (expires_at),
      CONSTRAINT fk_church_sessions_admin FOREIGN KEY (username) REFERENCES church_admins(username)
        ON UPDATE CASCADE ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];
  for (const statement of statements) await pool.query(statement);
  await pool.query(`INSERT IGNORE INTO app_schema_migrations (version) VALUES ('001_initial_church_data')`);
  await pool.query(`INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES
    ('church_logo', ?), ('ticket_counter', '1000')`, [defaultChurchLogo]);

  const [[eventCount]] = await pool.query('SELECT COUNT(*) AS count FROM church_events');
  if (Number(eventCount.count) === 0) {
    await pool.execute(
      `INSERT INTO church_events (id, title, verse, event_date, event_time, logo, active, themes)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      ['evt-1', 'اليوم الروحي للخدام', defaultVerse, '2026-11-14', '7:00 ص', defaultEventLogo,
        JSON.stringify([...themeNames].slice(0, 6))]
    );
  }

  const [[adminCount]] = await pool.query('SELECT COUNT(*) AS count FROM church_admins');
  if (Number(adminCount.count) === 0) {
    await pool.execute('INSERT INTO church_admins (username, password_hash) VALUES (?, ?)',
      ['admin', await hashPassword('123456')]);
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 32);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, keyHex] = String(stored || '').split(':');
  if (!salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = Buffer.from(await scrypt(String(password), salt, expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

const makeCookie = (token, maxAge) =>
  `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=None; Secure`;

async function getSessionUser(req) {
  const token = cookieValue(req, COOKIE_NAME);
  if (!token) return null;
  const [rows] = await pool.execute(
    `SELECT s.username FROM church_admin_sessions s
     INNER JOIN church_admins a ON a.username = s.username
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() LIMIT 1`,
    [hashToken(token)]
  );
  return rows[0]?.username || null;
}

async function requireAdmin(req) {
  const username = await getSessionUser(req);
  if (!username) throw new HttpError(401, 'يجب تسجيل دخول الأدمن أولاً.');
  return username;
}

async function getPublicState() {
  const [[eventRows], [logoRows], [counterRows], [countRows]] = await Promise.all([
    pool.query('SELECT * FROM church_events ORDER BY created_at DESC'),
    pool.execute("SELECT setting_value FROM app_settings WHERE setting_key = 'church_logo' LIMIT 1"),
    pool.execute("SELECT setting_value FROM app_settings WHERE setting_key = 'ticket_counter' LIMIT 1"),
    pool.query('SELECT event_id, COUNT(*) AS count FROM church_tickets GROUP BY event_id')
  ]);
  const eventCounts = Object.fromEntries(countRows.map((row) => [row.event_id, Number(row.count)]));
  return {
    events: eventRows.map(mapEvent),
    churchLogo: logoRows[0]?.setting_value || defaultChurchLogo,
    counter: Number(counterRows[0]?.setting_value || 1000),
    eventCounts,
    availableThemes: [...themeNames]
  };
}

async function getAdminState() {
  const [publicState, [ticketRows], [attendanceRows], [adminRows]] = await Promise.all([
    getPublicState(),
    pool.query('SELECT * FROM church_tickets ORDER BY created_at DESC'),
    pool.query('SELECT * FROM church_attendance ORDER BY checked_at DESC'),
    pool.query('SELECT username FROM church_admins ORDER BY created_at ASC')
  ]);
  return {
    ...publicState,
    tickets: ticketRows.map(mapTicket),
    attendance: attendanceRows.map(mapAttendance),
    admins: adminRows.map((row) => ({ username: row.username }))
  };
}

async function createBookings(entries) {
  const normalized = (Array.isArray(entries) ? entries : []).map((entry) => ({
    name: cleanText(entry.name, 160),
    stage: cleanText(entry.stage, 160, 'خدمة عامة'),
    phone: cleanText(entry.phone, 40),
    theme: cleanText(entry.theme, 80)
  })).filter((entry) => entry.name);
  if (!normalized.length) throw new HttpError(400, 'اكتب اسم شخص واحد على الأقل لإتمام الحجز.');
  if (normalized.length > 300) throw new HttpError(400, 'الحد الأقصى للحجز الواحد هو 300 اسم.');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [events] = await connection.query('SELECT * FROM church_events WHERE active = 1 LIMIT 1 FOR UPDATE');
    const activeEvent = events[0];
    if (!activeEvent) throw new HttpError(409, 'لا توجد فعالية نشطة للحجز حالياً.');
    const allowedThemes = parseThemes(activeEvent.themes);
    const chosenTheme = allowedThemes.includes(normalized[0].theme)
      ? normalized[0].theme : (allowedThemes[0] || 'theme-navy-gold');
    const [[counterRow]] = await connection.execute(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'ticket_counter' FOR UPDATE"
    );
    let counter = Number(counterRow?.setting_value || 1000);
    const created = [];
    for (const entry of normalized) {
      counter += 1;
      const ticket = {
        code: `SERV-${counter}`,
        name: entry.name,
        stage: entry.stage,
        phone: entry.phone,
        eventId: activeEvent.id,
        theme: allowedThemes.includes(entry.theme) ? entry.theme : chosenTheme
      };
      await connection.execute(
        `INSERT INTO church_tickets (code, name, stage, phone, event_id, theme)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ticket.code, ticket.name, ticket.stage, ticket.phone, ticket.eventId, ticket.theme]
      );
      created.push(ticket);
    }
    await connection.execute(
      "UPDATE app_settings SET setting_value = ? WHERE setting_key = 'ticket_counter'",
      [String(counter)]
    );
    await connection.commit();
    return { event: mapEvent(activeEvent), tickets: created, counter };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createAttendance(codeInput) {
  const code = cleanText(codeInput, 40).replace(/^#/, '').toUpperCase();
  if (!code) throw new HttpError(400, 'أدخل كود الدعوة.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [ticketRows] = await connection.execute('SELECT * FROM church_tickets WHERE code = ? FOR UPDATE', [code]);
    const ticket = ticketRows[0];
    if (!ticket) throw new HttpError(404, 'الكود غير موجود في سجل الدعوات.');
    const [activeRows] = await connection.query('SELECT id FROM church_events WHERE active = 1 LIMIT 1');
    if (ticket.event_id !== activeRows[0]?.id) throw new HttpError(409, `هذه الدعوة تخص فعالية أخرى: ${ticket.name}`);
    const [existing] = await connection.execute('SELECT id FROM church_attendance WHERE code = ? LIMIT 1', [code]);
    if (existing.length) throw new HttpError(409, `تم تسجيل حضور ${ticket.name} مسبقاً.`);
    const [[earlyRow]] = await connection.execute(
      'SELECT COUNT(*) AS count FROM church_attendance WHERE event_id = ? AND is_early = 1',
      [ticket.event_id]
    );
    const isEarly = Number(earlyRow.count) < 40;
    await connection.execute(
      `INSERT INTO church_attendance (code, name, stage, event_id, is_early)
       VALUES (?, ?, ?, ?, ?)`,
      [ticket.code, ticket.name, ticket.stage, ticket.event_id, isEarly ? 1 : 0]
    );
    const [[saved]] = await connection.execute('SELECT * FROM church_attendance WHERE code = ? LIMIT 1', [code]);
    await connection.commit();
    return mapAttendance(saved);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function readStaticFile(res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'رابط الملف غير صحيح.'); }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) throw new HttpError(404, 'الصفحة غير موجودة.');
  try { await access(filePath); } catch { throw new HttpError(404, 'الصفحة غير موجودة.'); }
  const contentTypes = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };
  res.writeHead(200, {
    'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600'
  });
  createReadStream(filePath).pipe(res);
}

async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = req.method || 'GET';
  const route = url.pathname;

  if (!route.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'الطريقة غير مسموحة.');
    if (method === 'HEAD') {
      const file = path.resolve(publicDir, route === '/' ? 'index.html' : `.${route}`);
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Length': content.length, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end();
    }
    return readStaticFile(res, route);
  }

  if (route === '/api/health' && method === 'GET') return sendJson(res, 200, { status: 'ok' });
  if (route === '/api/bootstrap' && method === 'GET') return sendJson(res, 200, await getPublicState());
  if (route === '/api/auth/me' && method === 'GET') {
    const username = await getSessionUser(req);
    return sendJson(res, 200, { username });
  }
  if (route === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const username = cleanText(body.username, 64);
    const password = String(body.password ?? '');
    const [admins] = await pool.execute('SELECT * FROM church_admins WHERE username = ? LIMIT 1', [username]);
    const valid = admins[0] && await verifyPassword(password, admins[0].password_hash);
    if (!valid) throw new HttpError(401, 'بيانات الدخول غير صحيحة، حاول مرة أخرى.');
    const token = randomBytes(32).toString('base64url');
    await pool.execute('DELETE FROM church_admin_sessions WHERE expires_at <= UTC_TIMESTAMP()');
    await pool.execute(
      'INSERT INTO church_admin_sessions (token_hash, username, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))',
      [hashToken(token), username, SESSION_DAYS]
    );
    return sendJson(res, 200, { username }, { 'Set-Cookie': makeCookie(token, SESSION_DAYS * 86400) });
  }
  if (route === '/api/auth/logout' && method === 'POST') {
    const token = cookieValue(req, COOKIE_NAME);
    if (token) await pool.execute('DELETE FROM church_admin_sessions WHERE token_hash = ?', [hashToken(token)]);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': makeCookie('', 0) });
  }
  if (route === '/api/bookings' && method === 'POST') {
    const body = await readJson(req);
    const result = await createBookings([body]);
    return sendJson(res, 201, { event: result.event, ticket: result.tickets[0], counter: result.counter });
  }
  if (route === '/api/bookings/batch' && method === 'POST') {
    const body = await readJson(req);
    const result = await createBookings(body.entries);
    return sendJson(res, 201, result);
  }

  if (route.startsWith('/api/admin/')) {
    const username = await requireAdmin(req);
    if (route === '/api/admin/data' && method === 'GET') return sendJson(res, 200, await getAdminState());
    if (route === '/api/admin/profile' && method === 'PUT') {
      const body = await readJson(req);
      const newUsername = cleanText(body.username, 64);
      const password = String(body.password ?? '');
      if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(newUsername)) throw new HttpError(400, 'اسم المستخدم يجب أن يتكون من حرفين على الأقل.');
      if (password.length < 6 || password.length > 200) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 6 أحرف.');
      const [collision] = await pool.execute('SELECT username FROM church_admins WHERE username = ? AND username <> ? LIMIT 1', [newUsername, username]);
      if (collision.length) throw new HttpError(409, 'اسم المستخدم مستخدم بالفعل.');
      const passwordHash = await hashPassword(password);
      await pool.execute('UPDATE church_admins SET username = ?, password_hash = ? WHERE username = ?', [newUsername, passwordHash, username]);
      return sendJson(res, 200, { username: newUsername });
    }
    if (route === '/api/admin/admins' && method === 'POST') {
      const body = await readJson(req);
      const newUsername = cleanText(body.username, 64);
      const password = String(body.password ?? '');
      if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(newUsername)) throw new HttpError(400, 'اسم المستخدم يجب أن يتكون من حرفين على الأقل.');
      if (password.length < 6 || password.length > 200) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 6 أحرف.');
      const [existing] = await pool.execute('SELECT username FROM church_admins WHERE username = ? LIMIT 1', [newUsername]);
      if (existing.length) throw new HttpError(409, 'هذا المشرف موجود بالفعل!');
      await pool.execute('INSERT INTO church_admins (username, password_hash) VALUES (?, ?)', [newUsername, await hashPassword(password)]);
      return sendJson(res, 201, { username: newUsername });
    }
    const deleteAdmin = route.match(/^\/api\/admin\/admins\/([^/]+)$/);
    if (deleteAdmin && method === 'DELETE') {
      const target = decodeURIComponent(deleteAdmin[1]);
      if (target === username) throw new HttpError(400, 'لا يمكن حذف الحساب الذي سجلت الدخول به.');
      const [[countRow]] = await pool.query('SELECT COUNT(*) AS count FROM church_admins');
      if (Number(countRow.count) <= 1) throw new HttpError(409, 'لا يمكن حذف آخر حساب أدمن.');
      await pool.execute('DELETE FROM church_admins WHERE username = ?', [target]);
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/admin/events' && method === 'POST') {
      const body = await readJson(req);
      const title = cleanText(body.title, 255);
      const verse = cleanText(body.verse, 3000, defaultVerse);
      const date = cleanText(body.date, 16);
      const time = cleanText(body.time, 80, '7:00 ص');
      const themes = parseThemes(body.themes);
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'أدخل اسم الفعالية وتاريخاً صحيحاً.');
      const id = `evt-${randomBytes(12).toString('hex')}`;
      const logo = cleanText(body.logo, 2_500_000, defaultChurchLogo);
      await pool.query('UPDATE church_events SET active = 0 WHERE active = 1');
      await pool.execute(
        `INSERT INTO church_events (id, title, verse, event_date, event_time, logo, active, themes)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [id, title, verse, date, time, logo, JSON.stringify(themes.length ? themes : ['theme-navy-gold'])]
      );
      return sendJson(res, 201, { event: mapEvent((await pool.execute('SELECT * FROM church_events WHERE id = ?', [id]))[0][0]) });
    }
    const updateEvent = route.match(/^\/api\/admin\/events\/([^/]+)$/);
    if (updateEvent && method === 'PUT') {
      const id = decodeURIComponent(updateEvent[1]);
      const body = await readJson(req);
      const [rows] = await pool.execute('SELECT * FROM church_events WHERE id = ? LIMIT 1', [id]);
      if (!rows.length) throw new HttpError(404, 'الفعالية غير موجودة.');
      const existing = rows[0];
      const assignments = [];
      const values = [];
      if ('title' in body) { assignments.push('title = ?'); values.push(cleanText(body.title, 255)); }
      if ('verse' in body) { assignments.push('verse = ?'); values.push(cleanText(body.verse, 3000, defaultVerse)); }
      if ('date' in body) {
        const date = cleanText(body.date, 16);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'صيغة التاريخ غير صحيحة.');
        assignments.push('event_date = ?'); values.push(date);
      }
      if ('time' in body) { assignments.push('event_time = ?'); values.push(cleanText(body.time, 80, '7:00 ص')); }
      if ('themes' in body) {
        const themes = parseThemes(body.themes);
        assignments.push('themes = ?'); values.push(JSON.stringify(themes.length ? themes : ['theme-navy-gold']));
      }
      if ('logo' in body) { assignments.push('logo = ?'); values.push(cleanText(body.logo, 2_500_000)); }
      if (body.active === true) await pool.query('UPDATE church_events SET active = 0 WHERE active = 1');
      if (body.active !== undefined) { assignments.push('active = ?'); values.push(body.active ? 1 : 0); }
      if (assignments.length) {
        values.push(id);
        await pool.execute(`UPDATE church_events SET ${assignments.join(', ')} WHERE id = ?`, values);
      }
      const [[saved]] = await pool.execute('SELECT * FROM church_events WHERE id = ? LIMIT 1', [id]);
      return sendJson(res, 200, { event: mapEvent(saved) });
    }
    if (route === '/api/admin/church-logo' && method === 'PUT') {
      const body = await readJson(req);
      const logo = cleanText(body.logo, 2_500_000);
      if (!logo.startsWith('data:image/') && !/^https:\/\//i.test(logo)) throw new HttpError(400, 'صيغة الشعار غير مدعومة.');
      await pool.execute("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'church_logo'", [logo]);
      return sendJson(res, 200, { churchLogo: logo });
    }
    if (route === '/api/admin/checkins' && method === 'POST') {
      const body = await readJson(req);
      const attendance = await createAttendance(body.code);
      return sendJson(res, 201, { attendance });
    }
    throw new HttpError(404, 'مسار الإدارة غير موجود.');
  }

  throw new HttpError(404, 'المسار غير موجود.');
}

const server = createServer(async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    sendError(res, error);
  }
});

async function main() {
  await ensureSchema();
  server.listen(port, '0.0.0.0', () => console.log(`Church events server listening on ${port}`));
}

main().catch((error) => {
  console.error('Application startup failed:', error);
  process.exit(1);
});
