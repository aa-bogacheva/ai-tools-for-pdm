const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'boris.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SLOT_TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00'];
const NAME_MAX_LENGTH = 100;
const NBSP = ' ';

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

// --- SQLite ---

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS walk_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walk_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    booked_by TEXT,
    booked_at TEXT,
    UNIQUE (walk_date, slot_time),
    CHECK (
      (booked_by IS NULL AND booked_at IS NULL)
      OR
      (booked_by IS NOT NULL AND booked_at IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL,
    fed_at TEXT NOT NULL
  );
`);

const insertSlot = db.prepare(
  'INSERT OR IGNORE INTO walk_slots (walk_date, slot_time) VALUES (?, ?)'
);
const selectSlots = db.prepare(
  'SELECT slot_time, booked_by FROM walk_slots WHERE walk_date = ? ORDER BY slot_time'
);
const selectSlot = db.prepare(
  'SELECT booked_by FROM walk_slots WHERE walk_date = ? AND slot_time = ?'
);
// Атомарная запись: обновляется только свободный слот.
const bookSlot = db.prepare(
  `UPDATE walk_slots SET booked_by = ?, booked_at = ?
   WHERE walk_date = ? AND slot_time = ? AND booked_by IS NULL`
);
const insertFeeding = db.prepare(
  'INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)'
);
const selectLastFeeding = db.prepare(
  'SELECT employee_name, fed_at FROM feedings ORDER BY fed_at DESC, id DESC LIMIT 1'
);

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureSlots(date) {
  for (const time of SLOT_TIMES) insertSlot.run(date, time);
}

function getState() {
  const date = today();
  ensureSlots(date);
  const slots = selectSlots
    .all(date)
    .map((row) => ({ time: row.slot_time, bookedBy: row.booked_by }));
  const feeding = selectLastFeeding.get();
  return {
    date,
    slots,
    lastFeeding: feeding
      ? { name: feeding.employee_name, fedAt: feeding.fed_at }
      : null,
  };
}

// --- HTTP ---

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeName(value) {
  if (typeof value !== 'string') throw new HttpError(400, `Введите имя и${NBSP}фамилию`);
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, `Введите имя и${NBSP}фамилию`);
  if (name.length > NAME_MAX_LENGTH) {
    throw new HttpError(400, `Имя и${NBSP}фамилия должны быть не${NBSP}длиннее ${NAME_MAX_LENGTH}${NBSP}символов`);
  }
  return name;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'Некорректный запрос'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function handleBook(req, res) {
  const body = await readJson(req);
  const time = body.time;
  if (!SLOT_TIMES.includes(time)) throw new HttpError(404, 'Такого слота нет');
  const name = normalizeName(body.name);

  const date = today();
  ensureSlots(date);
  const result = bookSlot.run(name, new Date().toISOString(), date, time);

  if (result.changes === 0) {
    const current = selectSlot.get(date, time);
    throw new HttpError(
      409,
      `Слот ${time} уже занят: с${NBSP}Борисом гуляет ${current.booked_by}. Выберите другое время`
    );
  }
  sendJson(res, 200, getState());
}

async function handleFeeding(req, res) {
  const body = await readJson(req);
  const name = normalizeName(body.name);
  insertFeeding.run(name, new Date().toISOString());
  sendJson(res, 201, getState());
}

function serveStatic(req, res) {
  const entry = STATIC_FILES[new URL(req.url, 'http://localhost').pathname];
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
    return;
  }
  fs.readFile(path.join(PUBLIC_DIR, entry.file), (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ошибка сервера');
      return;
    }
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, getState());
    }
    if (req.method === 'POST' && pathname === '/api/slots/book') {
      return await handleBook(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/feedings') {
      return await handleFeeding(req, res);
    }
    if (req.method === 'GET') return serveStatic(req, res);
    throw new HttpError(405, 'Метод не поддерживается');
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Ошибка сервера, попробуйте ещё раз' });
  }
});

server.listen(PORT, () => {
  console.log(`Борис ждёт на http://localhost:${PORT}`);
});
