const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const ejsMate = require('ejs-mate');

const i18next = require('i18next');
const i18nextMiddleware = require('i18next-http-middleware');
const i18nextFsBackend = require('i18next-fs-backend');

require('dotenv').config();


const ADMINS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

console.log('ADMINS parsed:', ADMINS);
 
function ensureAdmin(req, res, next) {
  if (req.user && ADMINS.includes(req.user.email.toLowerCase())) {
    return next();
  }
  return res.status(403).send('Forbidden');
}

const app = express();
const PORT = process.env.PORT || 3000;
const DEV_MODE = process.env.DEV_MODE || '0'; // 1 = all days unlocked
const OPEN_LOCAL_HOUR = parseInt(process.env.OPEN_LOCAL_HOUR || '0', 10);
// ---------------- DB init ----------------
// ---------------- DB init ----------------
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day INTEGER UNIQUE NOT NULL,
  text TEXT NOT NULL,
  answer TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, question_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
);
`);

// --- MIGRATION: add q_key + correct_index if missing ---
const cols = db.prepare(`PRAGMA table_info(questions)`).all().map(c => c.name);
if (!cols.includes('q_key')) {
  db.exec(`ALTER TABLE questions ADD COLUMN q_key TEXT`);
}
if (!cols.includes('correct_index')) {
  db.exec(`ALTER TABLE questions ADD COLUMN correct_index INTEGER NOT NULL DEFAULT 1`);
}


// Проставим q_key/correct_index для 25 дней (только если пусто или некорректно)
const correctMap = {
  1:2,  2:0,  3:2,  4:2,  5:3,
  6:1,  7:1,  8:0,  9:1,  10:1,
  11:1, 12:2, 13:1, 14:1, 15:2,
  16:0, 17:0, 18:1, 19:2, 20:3,
  21:2, 22:0, 23:2, 24:0, 25:1
};
const updQ = db.prepare(`UPDATE questions SET q_key = ?, correct_index = ? WHERE day = ?`);
const allQ = db.prepare(`SELECT day, q_key, correct_index FROM questions`).all();
const txMig = db.transaction(() => {
  allQ.forEach(r => {
    const badIdx = (r.correct_index == null || r.correct_index < 0 || r.correct_index > 3);
    if (!r.q_key || badIdx) {
      const d = r.day;
      const idx = correctMap[d] ?? 1;
      updQ.run(`q.${d}`, idx, d);
    }
  });
});
txMig();

// Сид, если таблица пустая
const countQ = db.prepare('SELECT COUNT(*) as c FROM questions').get().c;
if (countQ === 0) {
  const insertQ = db.prepare('INSERT INTO questions (day, text, answer) VALUES (?, ?, ?)');
  const insertMany = db.transaction(() => {
    for (let d = 1; d <= 25; d++) {
      insertQ.run(d, `How much is ${d} + ${d}?`, String(d + d));
    }
  });
  insertMany();
  console.log('Seeded 25 questions');
}

// ---------------- Helpers ----------------
function unlockedMaxDay() {
  if (DEV_MODE === '1') return 25;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11
  const day = now.getDate();
  const hour = now.getHours();

  // Вопросы открываются с 1 декабря по 25 декабря (месяц 11)
  if (year < 2025) return 0;
  if (year > 2025) return 25;

  // Если раньше декабря, вопросов нет
  if (month < 11) return 0;
  
  // Если после декабря, все 25 открыты
  if (month > 11) return 25;

  // В декабре (месяц 11): вопросы идут с 1 по 25 декабря
  if (month === 11) {
    if (day > 25) return 25; // После 25 декабря все открыты
    if (day < 1) return 0;
    
    const baseDay = day;
    
    // Если время еще не наступило, вопрос еще не открыт
    if (hour < OPEN_LOCAL_HOUR) return baseDay - 1;
    return baseDay;
  }

  return 0;
}

function getCurrentDayNumber() {
  // Возвращает номер текущего дня для подсвечивания (только если день еще не закончился)
  if (DEV_MODE === '1') return 1;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11
  const day = now.getDate();
  const hour = now.getHours();

  if (year < 2025 || year > 2025) return null;
  if (month !== 11) return null; // Только в декабре

  // Если время еще не наступило (день еще не начался), нет "текущего" дня
  if (hour < OPEN_LOCAL_HOUR) return null;

  // В декабре: текущий день это 1-25
  return day <= 25 ? day : null;
}

function normalizeAnswer(s) {
  return String(s || '').trim().toLowerCase();
}

function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  req.session.toast = { type: 'warn', text: req.t ? req.t('toasts.loginRequired') : 'Please sign in first.' };
  res.redirect('/login');
}

// ---------------- i18n ----------------
i18next
  .use(i18nextFsBackend)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['en', 'ka', 'uk'],
    backend: { loadPath: path.join(__dirname, 'locales/{{lng}}/{{ns}}.json') },
    detection: {
      order: ['querystring', 'cookie', 'header'],
      lookupQuerystring: 'lng',
      lookupCookie: 'i18next',
      caches: ['cookie']
    },
    preload: ['en', 'ka', 'uk'],
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false }
  });

// ---------------- App setup ----------------
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:"],
      "media-src": ["'self'"],
      "connect-src": ["'self'"]
    }
  }
}));

app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(i18nextMiddleware.handle(i18next));
app.use((req, res, next) => { res.locals.path = req.path; next(); });
// If running behind a proxy (e.g. on Heroku), enable trust proxy in production
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' },
}));

// ---------------- Passport ----------------
passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, (email, password, done) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return done(null, false, { message: 'auth.invalidCredentials' });
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return done(null, false, { message: 'auth.invalidCredentials' });
    }
    return done(null, user);
  } catch (e) {
    return done(e);
  }
}));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare('SELECT id, email, name, score, created_at FROM users WHERE id = ?').get(id);
    done(null, user);
  } catch (e) {
    done(e);
  }
});

app.use(passport.initialize());
app.use(passport.session());

// Locals (user + one-shot toast + t/lng)
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.toast = req.session.toast || null;
  delete req.session.toast;
  res.locals.t = req.t;
  res.locals.lng = req.language || 'en';
  next();
});

// ---------------- Routes ----------------
app.get('/lang/:lng', (req, res) => {
  const { lng } = req.params;
  const ok = ['en', 'ka', 'uk'].includes(lng);
  res.cookie('i18next', ok ? lng : 'en', { maxAge: 31536000000, sameSite: 'lax' });
  res.redirect('back');
});

app.get('/api/audio', (req, res) => {
  try {
    const audioDir = path.join(__dirname, 'public', 'audio');
    if (!fs.existsSync(audioDir)) return res.json({ tracks: [] });

    const allow = /\.(mp3|ogg|m4a|wav|webm)$/i;
    const files = fs.readdirSync(audioDir, { withFileTypes: true })
      .filter(d => d.isFile() && allow.test(d.name))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));

    const tracks = files.map(fn => {
      const title = fn.replace(/\.[^/.]+$/, '')
                      .replace(/[_-]+/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim();
      return { file: fn, url: '/audio/' + encodeURIComponent(fn), title };
    });

    res.json({ tracks });
  } catch (e) {
    console.error('audio api error', e);
    res.status(500).json({ tracks: [] });
  }
});
app.get('/questions', (req, res) => {
  const maxDay = unlockedMaxDay();

  let selectedDay;
  if (DEV_MODE === '1') {
    // DEV: можно выбирать день через ?day, если он <= maxDay
    selectedDay = parseInt(req.query.day || String(maxDay), 10);
    if (Number.isNaN(selectedDay) || selectedDay < 1 || selectedDay > 25) {
      selectedDay = maxDay;
    }
  } else {
    // PROD: один вопрос в день — всегда текущий
    selectedDay = maxDay; // если 0 — ничего нет
  }

  // Состояния по дням для сетки
  const statusByDay = {};
  for (let d = 1; d <= 25; d++) statusByDay[d] = { attempted: false, correct: false };
  if (req.user) {
    const rows = db.prepare(`
      SELECT q.day, s.is_correct
      FROM submissions s
      JOIN questions q ON s.question_id = q.id
      WHERE s.user_id = ?
    `).all(req.user.id);
    rows.forEach(r => { statusByDay[r.day] = { attempted: true, correct: !!r.is_correct }; });
  }

  // Выбранный день и его MCQ-данные
  let selected = null, attempted = false, alreadyCorrect = false;
  let qKey = null, correctIndex = 1, fallbackOptions = [];

  if (selectedDay >= 1 && selectedDay <= 25) {
    selected = db.prepare('SELECT id, day, q_key, correct_index FROM questions WHERE day = ?').get(selectedDay);
    if (selected) {
      qKey = selected.q_key || `q.${selected.day}`;
      correctIndex = (selected.correct_index ?? 1);

      const correctNumber = selected.day + selected.day;
      fallbackOptions = [correctNumber - 1, correctNumber, correctNumber + 1, correctNumber + 2].map(String);

      if (req.user) {
        const sub = db.prepare(`
          SELECT is_correct FROM submissions s
          JOIN questions q ON s.question_id = q.id
          WHERE s.user_id = ? AND q.day = ?
        `).get(req.user.id, selectedDay);
        attempted = !!sub;
        alreadyCorrect = sub ? !!sub.is_correct : false;
      }
    }
  }

  res.render('questions', {
    maxDay,
    selected,
    dayParam: selectedDay,
    attempted,
    alreadyCorrect,
    statusByDay,
    todayDay: getCurrentDayNumber(),
    qKey,
    correctIndex,
    fallbackOptions,
    bodyClass: 'bg-questions'
  });
});
app.get('/', (req, res) => {
  const maxDay = unlockedMaxDay();
  res.render('index', { maxDay, dev: DEV_MODE === '1', bodyClass: 'bg-home' });
});

app.get('/register', (req, res) => {
  res.render('register', { err: null, form: {} });
});
app.post('/register', (req, res) => {
  const { name, email, password } = req.body;
  const form = { name, email };

  if (!name || !email || !password) {
    return res.status(400).render('register', { err: req.t ? req.t('auth.errors.fillAll') : 'Please fill in all fields', form });
  }
  if (password.length < 6) {
    return res.status(400).render('register', { err: req.t ? req.t('auth.errors.passwordShort') : 'Password must be at least 6 characters', form });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
    ).run(
      name.trim(),
      email.toLowerCase().trim(),
      hash
    );
    req.session.toast = { type: 'ok', text: req.t ? req.t('toasts.registeredOk') : 'Registration successful! Please sign in.' };
    res.redirect('/login');
  } catch (e) {
    const msg = e && e.message && e.message.includes('UNIQUE')
      ? (req.t ? req.t('auth.errors.emailTaken') : 'This email is already registered')
      : (req.t ? req.t('auth.errors.userCreateFail') : 'Failed to create user');
    res.status(400).render('register', { err: msg, form });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { err: null });
});
app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).render('login', { err: req.t(info?.message || 'auth.invalidCredentials') });
    req.logIn(user, (err2) => {
      if (err2) return next(err2);
      req.session.toast = { type: 'ok', text: req.t('toasts.welcomeBack', { name: user.name }) || `Welcome back, ${user.name}!` };
      return res.redirect('/');
    });
  })(req, res, next);
});
app.post('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.toast = { type: 'ok', text: req.t ? req.t('toasts.loggedOut') : 'You have signed out.' };
    res.redirect('/');
  });
});


app.post('/questions/submit', ensureAuth, (req, res) => {
  const day = parseInt(req.body.day || '0', 10);
  const choice = Number(req.body.choice); // 0..3
  const maxDay = unlockedMaxDay();

  if (!day || day < 1 || day > 25) {
    req.session.toast = { type: 'warn', text: req.t ? req.t('toasts.dayInvalid') : 'Invalid day.' };
    return res.redirect('/questions');
  }
  if (day > maxDay) {
    req.session.toast = { type: 'warn', text: req.t ? req.t('toasts.dayLocked') : 'This day is not unlocked yet!' };
    return res.redirect('/questions?day=' + day);
  }
if (!Number.isInteger(choice) || choice < 0 || choice > 3) {
  req.session.toast = { type: 'warn', text: req.t('toasts.selectOption') };
  return res.redirect('/questions?day=' + day);
}

  const q = db.prepare('SELECT id, day, q_key, correct_index FROM questions WHERE day = ?').get(day);
  if (!q) {
    req.session.toast = { type: 'warn', text: req.t ? req.t('toasts.questionNotFound') : 'Question not found' };
    return res.redirect('/questions');
  }

  const existing = db.prepare('SELECT * FROM submissions WHERE user_id = ? AND question_id = ?').get(req.user.id, q.id);
  if (existing) {
    req.session.toast = { type: 'warn', text: req.t ? req.t('questions.alreadySubmitted') : 'You have already submitted an answer for this day.' };
    return res.redirect('/questions?day=' + day);
  }

  const isCorrect = choice === q.correct_index;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO submissions (user_id, question_id, is_correct) VALUES (?, ?, ?)').run(
      req.user.id, q.id, isCorrect ? 1 : 0
    );
    if (isCorrect) db.prepare('UPDATE users SET score = score + 1 WHERE id = ?').run(req.user.id);
  });
  tx();

  req.session.toast = { type: isCorrect ? 'ok' : 'warn', text: isCorrect ? (req.t ? req.t('toasts.answerCorrect') : 'Correct! +1 point') : (req.t ? req.t('toasts.answerWrong') : 'Wrong answer. Try again!') };
  return res.redirect('/questions?day=' + day);
});


app.get('/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT name, email, score, created_at
    FROM users
    ORDER BY score DESC, created_at ASC
  `).all();

  // Фильтруем админов
  const publicRows = rows
    .filter(u => !ADMINS.includes(u.email.toLowerCase()))
    .slice(0, 50); // берём топ-50 после фильтра

  // Шаблон использует только name/score/created_at
  const simplified = publicRows.map(u => ({
    name: u.name,
    score: u.score,
    created_at: u.created_at
  }));

  res.render('leaderboard', { rows: simplified, bodyClass: 'bg-leaderboard' });
});

// Экспорт ТОП N победителей (по умолчанию 10)
app.get('/admin/winners.csv', ensureAuth, ensureAdmin, (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '10', 10), 1000));
  const rows = db.prepare(`
    SELECT name, email, score, created_at
    FROM users
    ORDER BY score DESC, created_at ASC
  `).all();

  // Убираем админов
  const nonAdmins = rows.filter(u => !ADMINS.includes(u.email.toLowerCase()))
                        .slice(0, limit);

  const header = ['name','email','score','created_at'];
  const esc = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [header.join(',')].concat(
    nonAdmins.map(r => header.map(h => esc(r[h])).join(','))
  );

  const csv = lines.join('\n');
  const bom = '\uFEFF'; // чтобы кириллица в Excel была норм

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="winners.csv"');
  res.send(bom + csv);
});
app.get('/debug-me', ensureAuth, (req, res) => {
  console.log('ADMINS =', ADMINS);
  console.log('req.user =', req.user);
  res.send('Check server console');
});
// Экспорт всех пользователей
app.get('/admin/users.csv', ensureAuth, ensureAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT name, email, score, created_at
    FROM users
    ORDER BY created_at ASC
  `).all();

  const header = ['name','email','score','created_at'];
  const esc = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [header.join(',')].concat(
    rows.map(r => header.map(h => esc(r[h])).join(','))
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send(lines.join('\n'));
});
app.get('/admin/users', ensureAuth, ensureAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT name, email, score, created_at
    FROM users
    ORDER BY score DESC, created_at ASC
  `).all();
  res.render('admin_users', { rows });
});



// 404
app.use((req, res) => {
  res.status(404).render('index', { maxDay: unlockedMaxDay(), dev: DEV_MODE === '1' });
});

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Christmas Calendar 2025 running at http://${HOST}:${PORT}`);
  if (DEV_MODE === '1') {
    console.log('DEV_MODE=1: all days unlocked for testing. Set DEV_MODE=0 for real December 2025.');
  }
});