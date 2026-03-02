const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST','DELETE'] } });

app.use(cors());
app.use(express.json());

// ─── DOSSIERS ────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MISSIONS_FILE = path.join(DATA_DIR, 'missions.json');

[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use('/uploads', express.static(UPLOADS_DIR));

// ─── PERSISTENCE JSON ────────────────────────────────────────
function loadMissions() {
  try { return JSON.parse(fs.readFileSync(MISSIONS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMissions(data) {
  fs.writeFileSync(MISSIONS_FILE, JSON.stringify(data, null, 2));
}

let missions = loadMissions(); // { [code]: { meta, auditData, createdAt, createdBy } }
let connectedUsers = {};

// ─── HELPERS ─────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code + 'AUDIT_SALT_2024').digest('hex');
}

function generateCode() {
  // Code lisible : 3 groupes de 3 chiffres/lettres majuscules
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 6) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code; // Ex: "AB3-KP7-ZX2"
}

// ─── PAGE D'ACCUEIL SERVEUR ──────────────────────────────────
app.get('/', (req, res) => {
  const ip = getLocalIP();
  const total = Object.keys(missions).length;
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AUDIT MASTER - Serveur</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #070b14; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 520px; width: 90%; }
    .logo { font-size: 28px; font-weight: 900; color: #0ea5e9; margin-bottom: 6px; letter-spacing: .02em; }
    .sub { color: #64748b; font-size: 13px; margin-bottom: 32px; }
    .card { background: #111827; border: 1px solid #1f2d45; border-radius: 14px; padding: 28px; margin-bottom: 16px; }
    .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 6px; }
    input { width: 100%; background: #0d1526; border: 1px solid #1f2d45; border-radius: 8px; padding: 11px 14px; color: #e2e8f0; font-size: 15px; font-family: inherit; outline: none; margin-bottom: 12px; letter-spacing: .05em; }
    input:focus { border-color: #0ea5e9; }
    .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; transition: opacity .15s; }
    .btn:hover { opacity: .85; }
    .btn-blue { background: #0ea5e9; color: #fff; }
    .btn-green { background: #10b981; color: #fff; }
    .btn-ghost { background: transparent; border: 1px solid #1f2d45; color: #64748b; }
    .section-title { font-size: 13px; font-weight: 700; margin-bottom: 14px; color: #e2e8f0; }
    .sep { display: flex; align-items: center; gap: 12px; margin: 14px 0; }
    .sep span { color: #64748b; font-size: 12px; }
    .sep::before, .sep::after { content: ''; flex: 1; height: 1px; background: #1f2d45; }
    .stat { display: inline-flex; align-items: center; gap: 6px; background: #10b981; color: #fff; border-radius: 6px; padding: 4px 10px; font-size: 12px; font-weight: 600; }
    .stat-dot { width: 8px; height: 8px; background: #fff; border-radius: 50%; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; }
    .info-row span { color: #64748b; }
    .info-row code { font-family: monospace; color: #0ea5e9; background: #0ea5e922; padding: 1px 6px; border-radius: 4px; }
    .msg { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; display: none; }
    .msg.show { display: block; }
    .msg.success { background: #10b98120; color: #10b981; border: 1px solid #10b98140; }
    .msg.error { background: #ef444420; color: #ef4444; border: 1px solid #ef444440; }
    .code-display { font-family: monospace; font-size: 22px; font-weight: 800; color: #10b981; letter-spacing: .15em; text-align: center; padding: 14px; background: #10b98115; border: 2px solid #10b98140; border-radius: 10px; margin: 10px 0 6px; }
    .code-note { font-size: 11px; color: #64748b; text-align: center; margin-bottom: 10px; }
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
    .tab { flex: 1; padding: 8px; border: 1px solid #1f2d45; border-radius: 7px; background: transparent; color: #64748b; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all .15s; }
    .tab.active { background: #0ea5e922; border-color: #0ea5e944; color: #0ea5e9; }
  </style>
</head>
<body>
<div class="container">
  <div class="logo">⚖️ AUDIT MASTER</div>
  <div class="sub">Serveur collaboratif d'audit professionnel · <span class="stat"><span class="stat-dot"></span>${total} mission(s) active(s)</span></div>

  <div class="card">
    <div class="tabs">
      <button class="tab active" onclick="showTab('join')">Rejoindre une mission</button>
      <button class="tab" onclick="showTab('create')">Creer une mission</button>
    </div>

    <!-- REJOINDRE -->
    <div id="tab-join">
      <div class="section-title">Entrez votre code d'acces</div>
      <div id="msg-join" class="msg"></div>
      <div class="label">Code de mission (format: XXX-XXX-XXX)</div>
      <input id="join-code" placeholder="Ex: AB3-KP7-ZX2" maxlength="11" oninput="formatCode(this)" onkeydown="if(event.key==='Enter')joinMission()"/>
      <div class="label">Votre nom</div>
      <input id="join-name" placeholder="Ex: Jean Dupont" onkeydown="if(event.key==='Enter')joinMission()"/>
      <button class="btn btn-blue" onclick="joinMission()">Acceder a la mission</button>
      <div style="font-size:11px;color:#64748b;margin-top:10px;text-align:center">
        Le code vous a ete communique par le responsable de la mission
      </div>
    </div>

    <!-- CREER -->
    <div id="tab-create" style="display:none">
      <div class="section-title">Creer une nouvelle mission</div>
      <div id="msg-create" class="msg"></div>
      <div class="label">Nom de la mission</div>
      <input id="create-name" placeholder="Ex: Audit ABCDE SA 2024"/>
      <div class="label">Votre nom (responsable)</div>
      <input id="create-user" placeholder="Ex: Directeur Audit"/>
      <div class="label">Code secret personnalise (optionnel)</div>
      <input id="create-code" placeholder="Laisser vide pour generer automatiquement" maxlength="11" oninput="formatCode(this)"/>
      <div id="created-result" style="display:none">
        <div class="code-display" id="generated-code"></div>
        <div class="code-note">Notez ce code et partagez-le avec votre equipe</div>
        <button class="btn btn-green" id="btn-open-mission" onclick="openMission()">Ouvrir la mission</button>
      </div>
      <button class="btn btn-blue" id="btn-create" onclick="createMission()">Generer le code et creer la mission</button>
    </div>
  </div>

  <div class="card">
    <div class="info-row"><span>Adresse locale</span><code>localhost:${process.env.PORT || 3001}</code></div>
    <div class="info-row"><span>Adresse reseau</span><code>${ip}:${process.env.PORT || 3001}</code></div>
    <div class="info-row"><span>Missions enregistrees</span><code>${total}</code></div>
    <div style="font-size:11px;color:#64748b;margin-top:8px">Partagez l'adresse reseau avec vos collegues sur le meme reseau local</div>
  </div>
</div>

<script>
  function formatCode(input) {
    let v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length > 3) v = v.slice(0,3) + '-' + v.slice(3);
    if (v.length > 7) v = v.slice(0,7) + '-' + v.slice(7);
    input.value = v.slice(0,11);
  }

  function showTab(tab) {
    document.getElementById('tab-join').style.display = tab==='join' ? 'block' : 'none';
    document.getElementById('tab-create').style.display = tab==='create' ? 'block' : 'none';
    document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', (i===0&&tab==='join')||(i===1&&tab==='create')));
  }

  function showMsg(id, msg, type) {
    const el = document.getElementById(id);
    el.textContent = msg; el.className = 'msg show ' + type;
    setTimeout(() => { el.className = 'msg'; }, 5000);
  }

  async function joinMission() {
    const code = document.getElementById('join-code').value.trim();
    const name = document.getElementById('join-name').value.trim();
    if (!code || !name) return showMsg('msg-join', 'Veuillez remplir tous les champs', 'error');
    try {
      const res = await fetch('/api/mission/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({code,name}) });
      const data = await res.json();
      if (data.success) {
        window.location.href = '/app?code=' + encodeURIComponent(code) + '&name=' + encodeURIComponent(name);
      } else {
        showMsg('msg-join', data.error || 'Code incorrect', 'error');
      }
    } catch(e) { showMsg('msg-join', 'Erreur de connexion au serveur', 'error'); }
  }

  let _createdCode = '';
  async function createMission() {
    const missionName = document.getElementById('create-name').value.trim();
    const userName = document.getElementById('create-user').value.trim();
    const customCode = document.getElementById('create-code').value.trim();
    if (!missionName || !userName) return showMsg('msg-create', 'Veuillez remplir le nom de la mission et votre nom', 'error');
    try {
      const res = await fetch('/api/mission/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({missionName, userName, customCode}) });
      const data = await res.json();
      if (data.success) {
        _createdCode = data.code;
        document.getElementById('generated-code').textContent = data.code;
        document.getElementById('created-result').style.display = 'block';
        document.getElementById('btn-create').style.display = 'none';
        showMsg('msg-create', 'Mission creee avec succes ! Notez bien le code.', 'success');
      } else {
        showMsg('msg-create', data.error || 'Erreur creation', 'error');
      }
    } catch(e) { showMsg('msg-create', 'Erreur de connexion', 'error'); }
  }

  function openMission() {
    const name = document.getElementById('create-user').value.trim();
    window.location.href = '/app?code=' + encodeURIComponent(_createdCode) + '&name=' + encodeURIComponent(name);
  }
</script>
</body>
</html>`);
});

// ─── PAGE APP (redirige vers le frontend Vite) ───────────────
app.get('/app', (req, res) => {
  const { code, name } = req.query;
  if (!code || !name) return res.redirect('/');
  // En prod: servir le build Vite. En dev: rediriger vers :5173
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>AUDIT MASTER</title></head>
<body style="background:#070b14;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
  <div style="font-size:24px;font-weight:800;color:#0ea5e9">⚖️ AUDIT MASTER</div>
  <div style="font-size:14px;color:#64748b">Mission: <span style="color:#10b981;font-family:monospace">${code}</span> | Bienvenue <strong>${name}</strong></div>
  <div style="background:#111827;border:1px solid #1f2d45;border-radius:12px;padding:24px;max-width:420px;width:90%;text-align:center">
    <div style="font-size:13px;color:#64748b;margin-bottom:16px">L'application frontend doit tourner sur le port 5173</div>
    <a href="http://${getLocalIP()}:5173?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}" 
       style="display:block;background:#0ea5e9;color:#fff;border-radius:8px;padding:12px;font-weight:700;text-decoration:none;font-size:14px;margin-bottom:8px">
       Ouvrir l'application (reseau local)
    </a>
    <a href="http://localhost:5173?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}"
       style="display:block;background:transparent;border:1px solid #1f2d45;color:#64748b;border-radius:8px;padding:10px;text-decoration:none;font-size:13px">
       Ouvrir en local seulement
    </a>
  </div>
</body></html>`);
});

// ─── API MISSIONS ─────────────────────────────────────────────
// Creer une mission
app.post('/api/mission/create', (req, res) => {
  const { missionName, userName, customCode } = req.body;
  if (!missionName || !userName) return res.status(400).json({ error: 'Nom mission et utilisateur requis' });

  let code = customCode ? customCode.toUpperCase().replace(/[^A-Z0-9\-]/g,'') : generateCode();
  if (missions[code]) return res.status(400).json({ error: 'Ce code existe deja, choisissez-en un autre' });

  missions[code] = {
    code,
    missionName,
    createdBy: userName,
    createdAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    auditData: {
      id: 'AUD-' + Date.now(),
      perimeter: { entite: missionName, secteur:'', regime:'', debut:'', fin:'', responsable: userName, objectifs:'', capital:'', effectif:'', ca:'', processus:[], normes:[], equipe:[], orgNodes:[] },
      risks:[], swot:{ forces:[], faiblesses:[], opportunites:[], menaces:[] },
      program:{ checklist:[] }, documents:[],
      controls:{ tests:[], deficiences:[] },
      report:{ synthese:'', constats:[], recommandations:[], conclusion:'' }
    }
  };
  saveMissions(missions);
  console.log(`[MISSION CREEE] Code: ${code} | Nom: ${missionName} | Par: ${userName}`);
  res.json({ success: true, code, missionName });
});

// Verifier un code
app.post('/api/mission/verify', (req, res) => {
  const { code } = req.body;
  const mission = missions[code];
  if (!mission) return res.json({ success: false, error: 'Code de mission invalide ou inexistant' });
  res.json({ success: true, missionName: mission.missionName, createdBy: mission.createdBy, createdAt: mission.createdAt });
});

// Charger les donnees d'une mission
app.get('/api/mission/:code', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  res.json({ success: true, auditData: mission.auditData, meta: { missionName: mission.missionName, createdBy: mission.createdBy, createdAt: mission.createdAt, lastUpdate: mission.lastUpdate } });
});

// Sauvegarder les donnees d'une mission
app.post('/api/mission/:code/save', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  const { auditData } = req.body;
  missions[req.params.code].auditData = auditData;
  missions[req.params.code].lastUpdate = new Date().toISOString();
  saveMissions(missions);
  io.to(req.params.code).emit('data-synced', { timestamp: new Date(), savedBy: req.body.savedBy || 'Auditeur' });
  res.json({ success: true });
});

// Supprimer une mission
app.delete('/api/mission/:code', (req, res) => {
  if (!missions[req.params.code]) return res.status(404).json({ error: 'Mission introuvable' });
  delete missions[req.params.code];
  saveMissions(missions);
  res.json({ success: true });
});

// Lister toutes les missions (admin)
app.get('/api/missions', (req, res) => {
  const list = Object.values(missions).map(m => ({
    code: m.code, missionName: m.missionName, createdBy: m.createdBy,
    createdAt: m.createdAt, lastUpdate: m.lastUpdate,
    users: Object.values(connectedUsers).filter(u => u.missionCode === m.code).length
  }));
  res.json({ missions: list });
});

// ─── UPLOAD FICHIERS ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, req.body.missionCode || 'general');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '-' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Aucun fichier' });
  const ip = getLocalIP();
  const code = req.body.missionCode || 'general';
  const files = req.files.map(f => ({
    name: f.originalname, filename: f.filename,
    size: f.size, mimetype: f.mimetype,
    url: `http://${ip}:${process.env.PORT || 3001}/uploads/${code}/${f.filename}`,
    uploadedAt: new Date(), uploadedBy: req.body.user || 'Auditeur'
  }));
  res.json({ success: true, files });
});

// ─── SOCKET.IO TEMPS REEL ────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join-mission', ({ missionCode, userName }) => {
    socket.join(missionCode);
    connectedUsers[socket.id] = { userName, missionCode };
    const users = Object.values(connectedUsers).filter(u => u.missionCode === missionCode).map(u => u.userName);
    io.to(missionCode).emit('users-updated', users);
    socket.to(missionCode).emit('user-joined', { userName, time: new Date() });
    console.log(`[CONNEXION] ${userName} → mission ${missionCode}`);
  });

  socket.on('disconnect', () => {
    const user = connectedUsers[socket.id];
    if (user) {
      delete connectedUsers[socket.id];
      const users = Object.values(connectedUsers).filter(u => u.missionCode === user.missionCode).map(u => u.userName);
      io.to(user.missionCode).emit('users-updated', users);
      socket.to(user.missionCode).emit('user-left', { userName: user.userName });
    }
  });
});

// ─── DEMARRAGE ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     AUDIT MASTER — Serveur Securise    ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Local  : http://localhost:${PORT}         ║`);
  console.log(`║  Reseau : http://${ip}:${PORT}   ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Missions enregistrees : ${Object.keys(missions).length.toString().padEnd(14)}║`);
  console.log('║  Acces: ouvrir l\'adresse dans un nav.  ║');
  console.log('╚════════════════════════════════════════╝\n');
});
