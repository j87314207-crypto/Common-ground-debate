// Common Ground Debate — paid, structured debate platform starter
// Stack: Express + Helmet + rate-limit + sessions + better-sqlite3 + Stripe
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Stripe (optional until keys are set) ----------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn('⚠️  STRIPE_SECRET_KEY not set — /api/checkout will return 501 until configured.');
}

// ---------- Database ----------
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'debates.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS debates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  creator_id INTEGER,
  price_cents INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (creator_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS arguments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debate_id INTEGER NOT NULL,
  user_id INTEGER,
  side TEXT NOT NULL CHECK (side IN ('pro','con')),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (debate_id) REFERENCES debates(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  argument_id INTEGER NOT NULL,
  user_id INTEGER,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(argument_id, user_id),
  FOREIGN KEY (argument_id) REFERENCES arguments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS access_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debate_id INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  stripe_session_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(debate_id, user_email),
  FOREIGN KEY (debate_id) REFERENCES debates(id) ON DELETE CASCADE
);
`);

// Seed a demo debate if empty
const debateCount = db.prepare('SELECT COUNT(*) AS c FROM debates').get().c;
if (debateCount === 0) {
  db.prepare('INSERT INTO debates (title, description, price_cents, status) VALUES (?,?,?,?)')
    .run(
      'Should cities ban cars in downtown cores?',
      'A structured pro/con debate. Keep arguments under 500 characters, one claim per post, no personal attacks.',
      500,
      'open'
    );
  console.log('🌱 Seeded demo debate');
}

// ---------- Middleware ----------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));

// Stripe webhook needs the raw body — register it BEFORE express.json would consume it.
// We handle that by mounting the webhook with express.raw on its own route below.

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', limiter);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

// Tiny "auth": identify by email in session (replace with real auth later)
app.post('/api/session', (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    const r = db.prepare('INSERT INTO users (email) VALUES (?)').run(email.toLowerCase());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  }
  req.session.userId = user.id;
  req.session.email = user.email;
  res.json({ id: user.id, email: user.email });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  res.json({ id: req.session.userId, email: req.session.email });
});

function requireUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in first (POST /api/session with email)' });
  next();
}

// ---------- Debates API ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/debates', (req, res) => {
  const rows = db.prepare(`SELECT d.*, 
      (SELECT COUNT(*) FROM arguments a WHERE a.debate_id = d.id AND a.side='pro') AS pro_count,
      (SELECT COUNT(*) FROM arguments a WHERE a.debate_id = d.id AND a.side='con') AS con_count
    FROM debates d ORDER BY d.created_at DESC`).all();
  res.json(rows);
});

app.get('/api/debates/:id', (req, res) => {
  const debate = db.prepare('SELECT * FROM debates WHERE id = ?').get(req.params.id);
  if (!debate) return res.status(404).json({ error: 'Debate not found' });
  const args = db.prepare(`
    SELECT a.*, COALESCE(SUM(v.value),0) AS score, COUNT(v.id) AS votes
    FROM arguments a LEFT JOIN votes v ON v.argument_id = a.id
    WHERE a.debate_id = ? GROUP BY a.id ORDER BY score DESC, a.created_at ASC
  `).all(debate.id);
  res.json({ ...debate, arguments: args });
});

app.post('/api/debates', requireUser, (req, res) => {
  const { title, description = '', price_cents = 0 } = req.body || {};
  if (!title || title.trim().length < 8) {
    return res.status(400).json({ error: 'Title must be at least 8 characters' });
  }
  const r = db.prepare(
    'INSERT INTO debates (title, description, creator_id, price_cents) VALUES (?,?,?,?)'
  ).run(title.trim(), String(description).slice(0, 2000), req.session.userId, Math.max(0, parseInt(price_cents) || 0));
  res.status(201).json(db.prepare('SELECT * FROM debates WHERE id = ?').get(r.lastInsertRowid));
});

// Post a structured argument (pro/con)
app.post('/api/debates/:id/arguments', requireUser, (req, res) => {
  const debate = db.prepare('SELECT * FROM debates WHERE id = ?').get(req.params.id);
  if (!debate) return res.status(404).json({ error: 'Debate not found' });
  if (debate.status !== 'open') return res.status(403).json({ error: 'Debate is not open' });
  const { side, content } = req.body || {};
  if (!['pro', 'con'].includes(side)) return res.status(400).json({ error: "side must be 'pro' or 'con'" });
  if (!content || content.trim().length < 10 || content.trim().length > 2000) {
    return res.status(400).json({ error: 'Content must be 10–2000 characters' });
  }
  // Paid gate: if debate has a price, require an access grant
  if (debate.price_cents > 0) {
    const grant = db.prepare('SELECT 1 FROM access_grants WHERE debate_id = ? AND user_email = ?')
      .get(debate.id, req.session.email);
    const isCreator = debate.creator_id === req.session.userId;
    if (!grant && !isCreator) {
      return res.status(402).json({ error: 'Payment required', checkout: `/api/debates/${debate.id}/checkout` });
    }
  }
  const r = db.prepare('INSERT INTO arguments (debate_id, user_id, side, content) VALUES (?,?,?,?)')
    .run(debate.id, req.session.userId, side, content.trim());
  res.status(201).json(db.prepare('SELECT * FROM arguments WHERE id = ?').get(r.lastInsertRowid));
});

// Vote on an argument (+1 / -1), one vote per user per argument
app.post('/api/arguments/:id/vote', requireUser, (req, res) => {
  const arg = db.prepare('SELECT * FROM arguments WHERE id = ?').get(req.params.id);
  if (!arg) return res.status(404).json({ error: 'Argument not found' });
  const { value } = req.body || {};
  if (![1, -1].includes(value)) return res.status(400).json({ error: 'value must be 1 or -1' });
  db.prepare(`
    INSERT INTO votes (argument_id, user_id, value) VALUES (?,?,?)
    ON CONFLICT(argument_id, user_id) DO UPDATE SET value = excluded.value
  `).run(arg.id, req.session.userId, value);
  const score = db.prepare('SELECT COALESCE(SUM(value),0) AS s FROM votes WHERE argument_id = ?').get(arg.id).s;
  res.json({ argument_id: arg.id, score });
});

// ---------- Stripe: paid access ----------
app.post('/api/debates/:id/checkout', requireUser, async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });
  const debate = db.prepare('SELECT * FROM debates WHERE id = ?').get(req.params.id);
  if (!debate) return res.status(404).json({ error: 'Debate not found' });
  if (debate.price_cents <= 0) return res.status(400).json({ error: 'This debate is free' });

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.session.email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Access: ${debate.title}` },
          unit_amount: debate.price_cents,
        },
        quantity: 1,
      }],
      metadata: { debate_id: String(debate.id), user_email: req.session.email },
      success_url: `${baseUrl}/?debate=${debate.id}&paid=1`,
      cancel_url: `${baseUrl}/?debate=${debate.id}&paid=0`,
    });
    res.json({ url: checkoutSession.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// Stripe webhook (raw body). Configure STRIPE_WEBHOOK_SECRET in production.
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(501).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const debateId = parseInt(s.metadata?.debate_id, 10);
    const email = (s.metadata?.user_email || s.customer_email || '').toLowerCase();
    if (debateId && email) {
      db.prepare(`
        INSERT INTO access_grants (debate_id, user_email, stripe_session_id) VALUES (?,?,?)
        ON CONFLICT(debate_id, user_email) DO UPDATE SET stripe_session_id = excluded.stripe_session_id
      `).run(debateId, email, s.id);
      console.log(`✅ Granted ${email} access to debate ${debateId}`);
    }
  }
  res.json({ received: true });
});

// ---------- Minimal frontend ----------
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Common Ground — Structured Debates</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.5}
.card{border:1px solid #ddd;border-radius:12px;padding:1rem;margin:1rem 0}
.pro{border-left:4px solid #16a34a}.con{border-left:4px solid #dc2626}
button{cursor:pointer;padding:.5rem .9rem;border-radius:8px;border:1px solid #ccc;background:#111;color:#fff}
input,textarea,select{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;margin:.3rem 0}</style>
</head><body>
<h1>🟢 Common Ground</h1>
<p>Paid, structured pro/con debates. Sign in with email, pick a side, keep it civil.</p>
<div class="card"><h3>Sign in</h3>
<input id="email" placeholder="you@example.com"/><button onclick="signin()">Sign in</button>
<span id="me"></span></div>
<div class="card"><h3>Start a debate</h3>
<input id="title" placeholder="Debate title (min 8 chars)"/>
<textarea id="desc" placeholder="Description / rules"></textarea>
<input id="price" type="number" value="500" min="0" step="50" placeholder="Price in cents (0 = free)"/>
<button onclick="createDebate()">Create</button></div>
<h2>Debates</h2><div id="debates"></div>
<script>
async function api(p,o={}){const r=await fetch(p,{headers:{'Content-Type':'application/json'},...o});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j}
async function signin(){const email=document.getElementById('email').value;const me=await api('/api/session',{method:'POST',body:JSON.stringify({email})});document.getElementById('me').textContent=' ✓ '+me.email;load()}
async function load(){const ds=await api('/api/debates');document.getElementById('debates').innerHTML=ds.map(d=>
\`<div class="card"><h3>\${d.title}</h3><p>\${d.description||''}</p><p>💬 \${d.pro_count} pro / \${d.con_count} con · \${d.price_cents? '$'+(d.price_cents/100).toFixed(2)+' to join':'Free'} · \${d.status}</p><button onclick="view(\${d.id})">Open</button> \${d.price_cents? \`<button onclick="pay(\${d.id})">Pay & join</button>\`:''}</div>\`).join('')}
async function createDebate(){const title=document.getElementById('title').value,description=document.getElementById('desc').value,price_cents=+document.getElementById('price').value||0;await api('/api/debates',{method:'POST',body:JSON.stringify({title,description,price_cents})});load()}
async function pay(id){const s=await api('/api/debates/'+id+'/checkout',{method:'POST'});location.href=s.url}
async function view(id){const d=await api('/api/debates/'+id);const side=prompt('Side? pro/con');if(!side)return;const content=prompt('Your argument (10-2000 chars)');if(!content)return;
try{await api('/api/debates/'+id+'/arguments',{method:'POST',body:JSON.stringify({side,content})})}catch(e){alert(e.message);return}
const upd=await api('/api/debates/'+id);
alert('Arguments:\\n'+upd.arguments.map(a=>\`[\${a.side}] \${a.content.slice(0,80)} (score \${a.score})\`).join('\\n'))}
load();
</script></body></html>`);
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 Common Ground listening on http://localhost:${PORT}`));
