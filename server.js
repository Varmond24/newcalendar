const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const ejsMate = require('ejs-mate');

// Postgres + Sessions
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);

const i18next = require('i18next');
const i18nextMiddleware = require('i18next-http-middleware');
const i18nextFsBackend = require('i18next-fs-backend');

// 1. Config
require('dotenv').config();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEV_MODE = process.env.DEV_MODE || '0';
const OPEN_LOCAL_HOUR = parseInt(process.env.OPEN_LOCAL_HOUR || '0', 10);

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is missing in .env');
  process.exit(1);
}

// 2. DB Connection (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false,
});

const ADMINS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

console.log('Environment:', { DEV_MODE, PORT, HOST, OPEN_LOCAL_HOUR });
console.log('Admins:', ADMINS);

// 3. Helpers & Middleware
function unlockedMaxDay() {
  if (DEV_MODE === '1') return 25; // DEV: все открыто

  const now = new Date();
  if (now.getFullYear() < 2025) return 0;
  if (now.getFullYear() > 2025) return 25;
  if (now.getMonth() < 11) return 0;
  if (now.getMonth() > 11) return 25;

  const day = now.getDate();
  const hour = now.getHours();

  if (day < 1) return 0;
  if (day > 25) return 25;

  // Накопительное открытие: если час не настал, открыт предыдущий день
  const opened = hour >= OPEN_LOCAL_HOUR ? day : (day - 1);
  return Math.max(0, Math.min(opened, 25));
}

function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  req.session.toast = { type: 'warn', text: req.t ? req.t('toasts.loginRequired') : 'Please sign in first.' };
  res.redirect('/login');
}

function ensureAdmin(req, res, next) {
  if (req.user && ADMINS.includes(String(req.user.email).toLowerCase())) {
    return next();
  }
  return res.status(403).send('Forbidden');
}

// 4. Init DB Schema & Seed
async function initDb() {
  // Tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      phone TEXT,
      contact_consent INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id BIGSERIAL PRIMARY KEY,
      day INTEGER UNIQUE NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      answer TEXT NOT NULL DEFAULT '',
      q_key TEXT,
      correct_index INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      is_correct INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, question_id)
    );
  `);

  // Seed Correct Answers
  const correctMap = {
    1:2, 2:0, 3:2, 4:2, 5:3, 6:1, 7:1, 8:0, 9:1, 10:1,
    11:1, 12:2, 13:1, 14:1, 15:2, 16:0, 17:0, 18:1, 19:2, 20:3,
    21:2, 22:0, 23:2, 24:0, 25:1
  };

  // Upsert questions (day 1..25)
  for (let d = 1; d <= 25; d++) {
    const idx = correctMap[d] ?? 1;
    await pool.query(`
      INSERT INTO questions (day, q_key, correct_index, text, answer)
      VALUES ($1, $2, $3, '', '')
      ON CONFLICT (day) DO UPDATE 
      SET q_key = EXCLUDED.q_key, correct_index = EXCLUDED.correct_index
    `, [d, `q.${d}`, idx]);
  }
  console.log('DB Initialized & Questions Seeded');
}

// 5. App Setup
const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:"],
      "media-src": ["'self'"],
      "connect-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"] // unsafe-inline для простых скриптов, если остались
    }
  }
}));

app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// i18n
i18next
  .use(i18nextFsBackend)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['en', 'ka', 'uk'],
    backend: { loadPath: path.join(__dirname, 'locales/{{lng}}/{{ns}}.json') },
    detection: { order: ['cookie', 'header'], caches: ['cookie'] },
    preload: ['en', 'ka', 'uk'],
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false }
  });
app.use(i18nextMiddleware.handle(i18next));

// Session (Postgres store)
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true, 
    sameSite: 'lax'
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Global Middleware
app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  
  res.locals.user = req.user || null;
  res.locals.toast = req.session.toast || null;
  delete req.session.toast;
  
  res.locals.t = req.t;
  res.locals.lng = req.language || 'en';
  res.locals.path = req.path;
  res.locals.ADMINS = ADMINS;
  if (typeof res.locals.bodyClass === 'undefined') res.locals.bodyClass = '';
  
  next();
});

// Passport Strategy
passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, async (email, password, done) => {
  try {
    const normalized = String(email).toLowerCase().trim();
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [normalized]);
    const user = r.rows[0];
    if (!user) return done(null, false, { message: 'auth.invalidCredentials' });
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return done(null, false, { message: 'auth.invalidCredentials' });
    }
    return done(null, user);
  } catch (e) { return done(e); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const r = await pool.query(
      `SELECT id, email, name, score, created_at FROM users WHERE id = $1`,
      [id]
    );
    if (r.rows.length === 0) {
      return done(null, false); // User not found
    }
    done(null, r.rows[0]);
  } catch (e) {
    done(e);
  }
});

// 6. Routes

// Lang
app.get('/lang/:lng', (req, res) => {
  const { lng } = req.params;
  if (['en','ka','uk'].includes(lng)) res.cookie('i18next', lng, { maxAge: 31536000000 });
  res.redirect('back');
});

// Audio API (filesystem based)
app.get('/api/audio', (req, res) => {
  try {
    const audioDir = path.join(__dirname, 'public', 'audio');
    if (!fs.existsSync(audioDir)) return res.json({ tracks: [] });
    const files = fs.readdirSync(audioDir).filter(n => /\.(mp3|ogg|m4a|wav)$/i.test(n)).sort();
    const tracks = files.map(fn => ({ file: fn, url: '/audio/' + encodeURIComponent(fn), title: fn }));
    res.json({ tracks });
  } catch (e) { res.json({ tracks: [] }); }
});

// Home
app.get('/', (req, res) => {
  res.render('index', { maxDay: unlockedMaxDay(), dev: DEV_MODE === '1', bodyClass: 'bg-home' });
});

// Auth
app.get('/register', (req, res) => res.render('register', { err: null, form: {} }));
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  // Телефон и согласие игнорируем (упростили), но можно добавить в INSERT если нужно
  
  if (!name || !email || !password) {
    return res.status(400).render('register', { err: req.t('auth.errors.fillAll'), form: { name, email } });
  }
  if (password.length < 6) {
    return res.status(400).render('register', { err: req.t('auth.errors.passwordShort'), form: { name, email } });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const normalized = String(email).toLowerCase().trim();
    await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)`,
      [String(name).trim(), normalized, hash]
    );
    req.session.toast = { type: 'ok', text: req.t('toasts.registeredOk') };
    res.redirect('/login');
  } catch (e) {
    const msg = String(e?.message).includes('unique') ? req.t('auth.errors.emailTaken') : req.t('auth.errors.userCreateFail');
    res.status(400).render('register', { err: msg, form: { name, email } });
  }
});

app.get('/login', (req, res) => res.render('login', { err: null }));
app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).render('login', { err: req.t(info?.message || 'auth.invalidCredentials') });
    req.logIn(user, (err2) => {
      if (err2) return next(err2);
      req.session.toast = { type: 'ok', text: req.t('toasts.welcomeBack', { name: user.name }) };
      return res.redirect('/');
    });
  })(req, res, next);
});

app.post('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.toast = { type: 'ok', text: req.t('toasts.loggedOut') };
    res.redirect('/');
  });
});

// Questions (MCQ + Single Attempt)
app.get('/questions', async (req, res, next) => {
  try {
    const maxDay = unlockedMaxDay();
    let selectedDay = parseInt(req.query.day || String(maxDay), 10);
    if (Number.isNaN(selectedDay)) selectedDay = maxDay;
    if (maxDay <= 0) selectedDay = 0;
    
    // Накопительная логика (можно открыть 1..maxDay)
    if (selectedDay < 1 || selectedDay > maxDay) selectedDay = maxDay;

    const statusByDay = {};
    for (let d = 1; d <= 25; d++) statusByDay[d] = { attempted: false, correct: false };

    if (req.user) {
      const r = await pool.query(`
        SELECT q.day, s.is_correct
        FROM submissions s
        JOIN questions q ON s.question_id = q.id
        WHERE s.user_id = $1
      `, [req.user.id]);
      r.rows.forEach(row => {
        statusByDay[row.day] = { attempted: true, correct: !!row.is_correct };
      });
    }

    let selected = null, attempted = false, alreadyCorrect = false;
    let qKey = null, correctIndex = 1, fallbackOptions = [];

    if (selectedDay >= 1 && selectedDay <= 25) {
      const qr = await pool.query(`SELECT id, day, q_key, correct_index FROM questions WHERE day = $1`, [selectedDay]);
      selected = qr.rows[0] || null;

      if (selected) {
        qKey = selected.q_key || `q.${selected.day}`;
        correctIndex = selected.correct_index ?? 1;
        const cn = selected.day * 2; // dummy fallback
        fallbackOptions = [cn-1, cn, cn+1, cn+2].map(String);

        if (req.user) {
          const sr = await pool.query(
            `SELECT is_correct FROM submissions WHERE user_id = $1 AND question_id = $2`,
            [req.user.id, selected.id]
          );
          if (sr.rowCount > 0) {
            attempted = true;
            alreadyCorrect = !!sr.rows[0].is_correct;
          }
        }
      }
    }

    res.render('questions', {
      maxDay, selected, dayParam: selectedDay,
      attempted, alreadyCorrect, statusByDay,
      todayDay: maxDay,
      qKey, correctIndex, fallbackOptions,
      bodyClass: 'bg-questions'
    });
  } catch (e) { next(e); }
});

app.post('/questions/submit', ensureAuth, async (req, res, next) => {
  const day = parseInt(req.body.day || '0', 10);
  const choice = Number(req.body.choice);
  const maxDay = unlockedMaxDay();

  if (!day || day < 1 || day > 25) {
    req.session.toast = { type: 'warn', text: req.t('toasts.dayInvalid') };
    return res.redirect('/questions');
  }
  if (day > maxDay) {
    req.session.toast = { type: 'warn', text: req.t('toasts.dayLocked') };
    return res.redirect('/questions');
  }
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) {
    req.session.toast = { type: 'warn', text: req.t('toasts.selectOption') };
    return res.redirect('/questions?day=' + day);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const qr = await client.query(`SELECT id, correct_index FROM questions WHERE day = $1`, [day]);
    if (qr.rowCount === 0) {
      await client.query('ROLLBACK');
      req.session.toast = { type: 'warn', text: req.t('toasts.questionNotFound') };
      return res.redirect('/questions');
    }
    const { id: qid, correct_index: correctIndex } = qr.rows[0];

    const exist = await client.query(`SELECT 1 FROM submissions WHERE user_id = $1 AND question_id = $2`, [req.user.id, qid]);
    if (exist.rowCount > 0) {
      await client.query('ROLLBACK');
      req.session.toast = { type: 'warn', text: req.t('questions.alreadySubmitted') };
      return res.redirect('/questions?day=' + day);
    }

    const isCorrect = (choice === correctIndex);
    await client.query(
      `INSERT INTO submissions (user_id, question_id, is_correct) VALUES ($1, $2, $3)`,
      [req.user.id, qid, isCorrect ? 1 : 0]
    );

    if (isCorrect) {
      await client.query(`UPDATE users SET score = score + 1 WHERE id = $1`, [req.user.id]);
    }

    await client.query('COMMIT');

    req.session.toast = {
      type: isCorrect ? 'ok' : 'warn',
      text: isCorrect ? req.t('toasts.answerCorrect') : req.t('toasts.answerWrongOneAttempt')
    };
    return res.redirect('/questions?day=' + day);

  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// Leaderboard
app.get('/leaderboard', async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT name, email, score, created_at FROM users ORDER BY score DESC, created_at ASC LIMIT 200`);
    const publicRows = r.rows
      .filter(u => !ADMINS.includes(String(u.email).toLowerCase()))
      .slice(0, 50);
    res.render('leaderboard', { rows: publicRows, bodyClass: 'bg-leaderboard' });
  } catch (e) { next(e); }
});

// Admin
app.get('/admin/winners.csv', ensureAuth, ensureAdmin, async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '10', 10), 1000));
    const r = await pool.query(`SELECT name, email, score, created_at FROM users ORDER BY score DESC, created_at ASC LIMIT 500`);
    const rows = r.rows.filter(u => !ADMINS.includes(String(u.email).toLowerCase())).slice(0, limit);

    const header = ['name','email','score','created_at'];
    const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v||'');
    const lines = [header.join(',')].concat(rows.map(r => header.map(h => esc(r[h])).join(',')));
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="winners.csv"');
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { next(e); }
});

app.get('/admin/users.csv', ensureAuth, ensureAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT name, email, score, created_at, phone, contact_consent FROM users ORDER BY created_at ASC`);
    const header = ['name','email','score','created_at','phone','contact_consent'];
    const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v||'');
    const lines = [header.join(',')].concat(r.rows.map(r => header.map(h => esc(r[h])).join(',')));
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { next(e); }
});

app.get('/admin/users', ensureAuth, ensureAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT id, name, email, score, created_at FROM users ORDER BY score DESC`);
    res.render('admin_users', { rows: r.rows });
  } catch (e) { next(e); }
});

app.post('/admin/users/:id/delete', ensureAuth, ensureAdmin, async (req, res, next) => {
  const targetId = parseInt(req.params.id);
  if (!targetId) return res.status(400).send('Bad ID');
  if (req.body.csrfToken !== req.session.csrfToken) return res.status(403).send('CSRF Fail');

  try {
    const r = await pool.query('SELECT email FROM users WHERE id = $1', [targetId]);
    if (r.rowCount === 0) {
      req.session.toast = { type: 'warn', text: 'Not found' };
      return res.redirect('/admin/users');
    }
    const email = String(r.rows[0].email).toLowerCase();
    if (ADMINS.includes(email) || (req.user && req.user.id == targetId)) {
      req.session.toast = { type: 'warn', text: 'Cannot delete admin/self' };
      return res.redirect('/admin/users');
    }
    const confirm = String(req.body.confirmEmail||'').trim().toLowerCase();
    if (confirm !== email) {
      req.session.toast = { type: 'warn', text: 'Email mismatch' };
      return res.redirect('/admin/users');
    }

    await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
    req.session.toast = { type: 'ok', text: 'Deleted' };
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

// 404
app.use((req, res) => res.status(404).render('index', { maxDay: unlockedMaxDay(), dev: DEV_MODE === '1', bodyClass: 'bg-home' }));

// 7. Start Server
(async () => {
  try {
    await initDb();
    app.listen(PORT, HOST, () => console.log(`Server running at http://${HOST}:${PORT}`));
  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
})();
