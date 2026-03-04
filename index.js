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
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST','DELETE','PUT'] } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── DOSSIERS ─────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BUILD_DIR   = path.join(__dirname, 'dist');   // npm run build → dist/
const MISSIONS_FILE = path.join(DATA_DIR, 'missions.json');

[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── SERVIR LE BUILD VITE (après npm run build) ───────────────
if (fs.existsSync(BUILD_DIR)) {
  app.use(express.static(BUILD_DIR));
  console.log('[BUILD] Serveur le build Vite depuis /dist');
}

// ─── PERSISTENCE ──────────────────────────────────────────────
function loadMissions() {
  try { return JSON.parse(fs.readFileSync(MISSIONS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMissions(data) {
  fs.writeFileSync(MISSIONS_FILE, JSON.stringify(data, null, 2));
}

let missions = loadMissions();
let connectedUsers = {}; // { socketId: { userName, missionCode, isCreator } }

// ─── HELPERS ──────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 6) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getUsersInMission(missionCode) {
  return Object.values(connectedUsers)
    .filter(u => u.missionCode === missionCode)
    .map(u => ({ name: u.userName, isCreator: u.isCreator }));
}

// ─── PAGE D'ACCUEIL (mode dev sans build) ────────────────────
app.get('/', (req, res) => {
  // Si build Vite existe, on sert index.html
  const indexHtml = path.join(BUILD_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  // Sinon, page de statut dev
  const ip = getLocalIP();
  const total = Object.keys(missions).length;
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AUDIT MASTER - Serveur</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#070b14;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .wrap{max-width:500px;width:90%;padding:24px 0}
    h1{font-size:26px;font-weight:900;color:#0ea5e9;margin-bottom:4px}
    .sub{color:#64748b;font-size:13px;margin-bottom:28px}
    .card{background:#111827;border:1px solid #1f2d45;border-radius:14px;padding:24px;margin-bottom:14px}
    .badge{display:inline-flex;align-items:center;gap:6px;background:#10b98120;color:#10b981;border:1px solid #10b98140;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600}
    .dot{width:8px;height:8px;background:#10b981;border-radius:50%;animation:pulse 1.5s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .row{display:flex;justify-content:space-between;margin-bottom:7px;font-size:13px}
    .row span{color:#64748b}
    code{font-family:monospace;color:#0ea5e9;background:#0ea5e915;padding:1px 7px;border-radius:4px}
    .tip{background:#f59e0b15;border:1px solid #f59e0b40;border-radius:10px;padding:14px;font-size:12px;color:#f59e0b;margin-top:14px}
    .tip strong{display:block;margin-bottom:6px;font-size:13px}
  </style>
</head>
<body>
<div class="wrap">
  <h1>⚖️ AUDIT MASTER</h1>
  <div class="sub">Serveur API actif · <span class="badge"><span class="dot"></span>${total} mission(s)</span></div>
  <div class="card">
    <div class="row"><span>Adresse locale</span><code>localhost:${process.env.PORT||3001}</code></div>
    <div class="row"><span>Adresse reseau</span><code>${ip}:${process.env.PORT||3001}</code></div>
    <div class="row"><span>Missions enregistrees</span><code>${total}</code></div>
    <div class="row"><span>Statut build</span><code>${fs.existsSync(BUILD_DIR)?'dist/ present — build OK':'dist/ absent — mode dev'}</code></div>
  </div>
  <div class="tip">
    <strong>Pour deployer l'application sur ce serveur :</strong>
    1. Dans le dossier frontend : <code>npm run build</code><br>
    2. Copier le dossier <code>dist/</code> dans le dossier server/<br>
    3. Redemarrer le serveur<br>
    4. Partager <code>http://${ip}:${process.env.PORT||3001}</code> avec vos collegues
  </div>
</div>
</body>
</html>`);
});

// ─── API : CREER UNE MISSION ──────────────────────────────────
app.post('/api/mission/create', (req, res) => {
  const { missionName, userName, customCode } = req.body;
  if (!missionName || !userName) return res.status(400).json({ error: 'Champs requis manquants' });

  let code = customCode
    ? customCode.toUpperCase().replace(/[^A-Z0-9\-]/g, '')
    : generateCode();

  if (missions[code]) return res.status(400).json({ error: 'Ce code existe deja' });

  missions[code] = {
    code,
    missionName,
    createdBy: userName,          // ← nom du créateur
    createdAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    auditData: {
      id: 'AUD-' + Date.now(),
      perimeter: { entite: missionName, secteur:'', regime:'', debut:'', fin:'', responsable: userName, objectifs:'', capital:'', effectif:'', ca:'', processus:[], normes:[], equipe:[], orgNodes:[] },
      risks:[], swot:{ forces:[], faiblesses:[], opportunites:[], menaces:[] },
      program:{ checklist:[] }, documents:[],
      controls:{ tests:[], deficiences:[] },
      report:{ synthese:'', constats:[], recommandations:[], conclusion:'' },
      conversations:{ messages:[] },
      // journal des connexions locales (utile pour rapports)
      connectionLogs: []
    }
  };
  saveMissions(missions);
  console.log(`[MISSION CREEE] ${code} — ${missionName} par ${userName}`);
  res.json({ success: true, code, missionName, createdBy: userName });
});

// ─── API : VERIFIER CODE ──────────────────────────────────────
app.post('/api/mission/verify', (req, res) => {
  const { code, name } = req.body;
  const mission = missions[code];
  if (!mission) return res.json({ success: false, error: 'Code de mission invalide ou inexistant' });
  const isCreator = mission.createdBy === name;
  res.json({ success: true, missionName: mission.missionName, createdBy: mission.createdBy, isCreator, createdAt: mission.createdAt });
});

// ─── API : CHARGER UNE MISSION ────────────────────────────────
app.get('/api/mission/:code', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  // ensure every saved message has a channel (migrating old data)
  if (mission.auditData && mission.auditData.conversations && Array.isArray(mission.auditData.conversations.messages)) {
    mission.auditData.conversations.messages = mission.auditData.conversations.messages.map(m => {
      if (!m.channel) m.channel = 'general';
      return m;
    });
  }
  res.json({
    success: true,
    auditData: mission.auditData,
    meta: { missionName: mission.missionName, createdBy: mission.createdBy, createdAt: mission.createdAt, lastUpdate: mission.lastUpdate }
  });
});

// ─── API : SAUVEGARDER (sauvegarde complète) ─────────────────
app.post('/api/mission/:code/save', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  const { auditData, savedBy } = req.body;
  missions[req.params.code].auditData = auditData;
  missions[req.params.code].lastUpdate = new Date().toISOString();
  saveMissions(missions);
  // Notifier les autres connectés
  io.to(req.params.code).emit('full-sync', { auditData, savedBy, timestamp: new Date().toISOString() });
  res.json({ success: true });
});

// ─── API : MISE A JOUR TEMPS REEL (un seul champ) ─────────────
// Utilisé par Socket.IO uniquement — pas de route HTTP

// ─── API : SUPPRIMER MISSION (créateur seulement) ─────────────
app.delete('/api/mission/:code', (req, res) => {
  const { userName } = req.body;
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.createdBy !== userName) {
    return res.status(403).json({ error: 'Seul le createur peut supprimer cette mission' });
  }
  // Supprimer les fichiers uploadés
  const uploadDir = path.join(UPLOADS_DIR, req.params.code);
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
  delete missions[req.params.code];
  saveMissions(missions);
  // Expulser tous les connectés
  io.to(req.params.code).emit('mission-deleted', { by: userName });
  console.log(`[MISSION SUPPRIMEE] ${req.params.code} par ${userName}`);
  res.json({ success: true });
});


// ─── API : CHANGER LE CODE D'ACCÈS ────────────────────────────
app.post('/api/mission/:code/change-code', (req, res) => {
  const { newCode, userName } = req.body;
  const oldCode = req.params.code;
  const mission = missions[oldCode];

  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.createdBy !== userName) {
    return res.status(403).json({ error: "Seul le createur peut modifier le code d'acces" });
  }
  if (!newCode || newCode.trim().length < 6) {
    return res.status(400).json({ error: 'Le nouveau code doit faire au moins 6 caractères' });
  }

  const formatted = newCode.toUpperCase().replace(/[^A-Z0-9\-]/g, '').substring(0, 11);

  if (missions[formatted] && formatted !== oldCode) {
    return res.status(400).json({ error: 'Ce code est déjà utilisé par une autre mission' });
  }

  // Copier la mission avec le nouveau code
  missions[formatted] = { ...mission, code: formatted, lastUpdate: new Date().toISOString() };
  if (formatted !== oldCode) {
    delete missions[oldCode];
  }
  saveMissions(missions);

  // Notifier tous les connectés de l'ancien code que le code a changé
  io.to(oldCode).emit('code-changed', { newCode: formatted, by: userName });

  console.log(`[CODE MODIFIE] ${oldCode} → ${formatted} par ${userName}`);
  res.json({ success: true, newCode: formatted, oldCode });
});

// ─── API : LISTER MISSIONS ────────────────────────────────────
app.get('/api/missions', (req, res) => {
  const list = Object.values(missions).map(m => ({
    code: m.code, missionName: m.missionName, createdBy: m.createdBy,
    createdAt: m.createdAt, lastUpdate: m.lastUpdate,
    online: getUsersInMission(m.code).length
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
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Aucun fichier' });
  const ip = getLocalIP();
  const PORT = process.env.PORT || 3001;
  const code = req.body.missionCode || 'general';
  const files = req.files.map(f => ({
    name: f.originalname, filename: f.filename, size: f.size, mimetype: f.mimetype,
    url: `http://${ip}:${PORT}/uploads/${code}/${f.filename}`,
    uploadedAt: new Date().toISOString(), uploadedBy: req.body.user || 'Auditeur'
  }));
  res.json({ success: true, files });
});

// ─── RAPPORT DE CONNEXIONS ─────────────────────────────────
app.get('/api/mission/:code/logs', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  const logs = mission.auditData.connectionLogs || [];
  const format = req.query.format || 'csv';
  if (format === 'json') {
    // enrich with durations and human text
    const enriched = logs.map(l => {
      const join = new Date(l.join);
      const leave = l.leave ? new Date(l.leave) : new Date();
      const durSec = Math.round((leave - join) / 1000);
      let text = '';
      const hrs = Math.floor(durSec / 3600);
      const mins = Math.floor((durSec % 3600) / 60);
      const days = Math.floor(hrs / 24);
      if (days) text += days + 'j ';
      if (hrs % 24) text += (hrs % 24) + 'h ';
      if (mins) text += mins + 'm';
      if (!text) text = durSec + 's';
      return { userName: l.userName, join: l.join, leave: l.leave, durationSeconds: durSec, durationText: text.trim() };
    });
    return res.json({ logs: enriched });
  }
  // csv/text
  const lines = ['userName,join,leave,durationSeconds'];
  logs.forEach(l => {
    const join = new Date(l.join);
    const leave = l.leave ? new Date(l.leave) : new Date();
    const dur = Math.round((leave - join) / 1000);
    lines.push(`${l.userName},${l.join},${l.leave || ''},${dur}`);
  });
  res.setHeader('Content-Type', 'text/csv');
  res.send(lines.join('\n'));
});

// ─── SPA FALLBACK (pour le build Vite) ───────────────────────
app.get('*', (req, res) => {
  const indexHtml = path.join(BUILD_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  res.status(404).json({ error: 'Route inconnue' });
});

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO — TEMPS REEL
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {

  // Rejoindre une mission
  socket.on('join', ({ missionCode, userName, isCreator }) => {
    socket.join(missionCode);
    connectedUsers[socket.id] = { userName, missionCode, isCreator: !!isCreator };

    // ajouter une entrée dans le journal de connexions
    if (missions[missionCode] && missions[missionCode].auditData) {
      if (!missions[missionCode].auditData.connectionLogs) {
        missions[missionCode].auditData.connectionLogs = [];
      }
      missions[missionCode].auditData.connectionLogs.push({ userName, join: new Date().toISOString(), leave: null });
      missions[missionCode].lastUpdate = new Date().toISOString();
      saveMissions(missions);
    }

    const users = getUsersInMission(missionCode);
    // Notifier tout le monde dans la mission
    io.to(missionCode).emit('users-update', users);
    socket.to(missionCode).emit('user-joined', { name: userName, time: new Date().toISOString() });
    console.log(`[CONNECTE] ${userName} → mission ${missionCode} (${users.length} connectes)`);
  });

  // Mise à jour d'un champ unique (temps réel)
  socket.on('field-update', ({ missionCode, path: fieldPath, value, userName }) => {
    // path = ex: "perimeter.entite" ou "risks" (tableau complet)
    if (missions[missionCode]) {
      // Appliquer la mise à jour dans le store serveur
      applyFieldUpdate(missions[missionCode].auditData, fieldPath, value);
      missions[missionCode].lastUpdate = new Date().toISOString();
      // Broadcast aux autres dans la mission
      socket.to(missionCode).emit('field-updated', { path: fieldPath, value, by: userName, at: new Date().toISOString() });
    }
  });

  // Mise à jour d'une section complète (tableaux)
  socket.on('section-update', ({ missionCode, section, data, userName }) => {
    if (missions[missionCode]) {
      missions[missionCode].auditData[section] = data;
      missions[missionCode].lastUpdate = new Date().toISOString();
      socket.to(missionCode).emit('section-updated', { section, data, by: userName, at: new Date().toISOString() });
    }
  });

  // Sauvegarde déclenchée par le client
  socket.on('save-request', ({ missionCode, auditData, userName }) => {
    if (!missions[missionCode]) return;
    missions[missionCode].auditData = auditData;
    missions[missionCode].lastUpdate = new Date().toISOString();
    saveMissions(missions);
    io.to(missionCode).emit('saved', { by: userName, at: new Date().toISOString() });
    console.log(`[SAUVEGARDE] Mission ${missionCode} par ${userName}`);
  });

  // Chat temps réel
  socket.on('chat-send', (msg, ack) => {
    if (!msg || !msg.missionCode) {
      if (ack) ack({ success: false, error: 'Message invalide' });
      return;
    }
    // make sure there is always a channel (old clients might not send one)
    if (!msg.channel) msg.channel = 'general';
    // Assurer un ID unique pour chaque message
    if (!msg.id) msg.id = Date.now() + Math.random();
    
    // Sauvegarder le message dans auditData si ce n'est pas un doublon
    if (missions[msg.missionCode] && missions[msg.missionCode].auditData) {
      if (!missions[msg.missionCode].auditData.conversations) {
        missions[msg.missionCode].auditData.conversations = { messages: [] };
      }
      const msgs = missions[msg.missionCode].auditData.conversations.messages;
      if (!msgs.some(m => m.id === msg.id)) {
        msgs.push(msg);
        missions[msg.missionCode].lastUpdate = new Date().toISOString();
        saveMissions(missions);
      } else {
        console.log(`[CHAT] Duplicate message ${msg.id} ignored`);
      }
    }
    // Broadcast à TOUS les membres de la mission (y compris l'émetteur)
    io.to(msg.missionCode).emit('chat-message', msg);
    const rooms = [...socket.rooms];
    console.log(`[CHAT] ${msg.auteur} → canal:${msg.channel} mission:${msg.missionCode} rooms:[${rooms.join(',')}]`);
    if (ack) ack({ success: true });
  });

  // Suppression d'un message
  socket.on('chat-delete', (data, ack) => {
    const { missionCode, messageId } = data;
    if (!missionCode || !messageId) {
      if (ack) ack({ success: false, error: 'Données invalides' });
      return;
    }
    // Supprimer du serveur
    if (missions[missionCode] && missions[missionCode].auditData && missions[missionCode].auditData.conversations) {
      const messages = missions[missionCode].auditData.conversations.messages;
      const idx = messages.findIndex(m => m.id === messageId);
      if (idx >= 0) {
        messages.splice(idx, 1);
        missions[missionCode].lastUpdate = new Date().toISOString();
        saveMissions(missions);
        // Notifier tous les connectés
        io.to(missionCode).emit('chat-deleted', { messageId });
        console.log(`[CHAT DELETE] Message ${messageId} supprimé`);
      }
    }
    if (ack) ack({ success: true });
  });

  // Typing indicator
  socket.on('chat-typing', (data) => {
    let { missionCode, channel, userName, isTyping } = data;
    console.log('[SERVER chat-typing]', data);
    channel = channel || 'general';
    // Envoyer à TOUS dans la mission SAUF l'émetteur
    console.log('[SERVER emit user-typing] broadcast to room:', missionCode, 'data:', { channel, userName, isTyping });
    socket.to(missionCode).emit('user-typing', { channel, userName, isTyping });
  });
  // Déconnexion
  socket.on('disconnect', () => {
    const user = connectedUsers[socket.id];
    if (user) {
      // enregistrer le départ dans le journal
      const code = user.missionCode;
      if (missions[code] && missions[code].auditData && Array.isArray(missions[code].auditData.connectionLogs)) {
        // chercher la dernière entrée sans leave pour cet utilisateur
        for (let i = missions[code].auditData.connectionLogs.length - 1; i >= 0; i--) {
          const entry = missions[code].auditData.connectionLogs[i];
          if (entry.userName === user.userName && !entry.leave) {
            entry.leave = new Date().toISOString();
            break;
          }
        }
        missions[code].lastUpdate = new Date().toISOString();
        saveMissions(missions);
      }

      delete connectedUsers[socket.id];
      const users = getUsersInMission(user.missionCode);
      io.to(user.missionCode).emit('users-update', users);
      socket.to(user.missionCode).emit('user-left', { name: user.userName, time: new Date().toISOString() });
      console.log(`[DECONNECTE] ${user.userName} (mission ${user.missionCode})`);
    }
  });
});

// Appliquer une mise à jour de chemin (ex: "perimeter.entite")
function applyFieldUpdate(obj, fieldPath, value) {
  const parts = fieldPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]]) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// ─── DEMARRAGE ────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const hasBuild = fs.existsSync(BUILD_DIR);
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    AUDIT MASTER — Serveur Temps Reel     ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local  : http://localhost:${PORT}           ║`);
  console.log(`║  Reseau : http://${ip}:${PORT}     ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Missions sauvegardees : ${Object.keys(missions).length.toString().padEnd(17)}║`);
  console.log(`║  Build Vite : ${hasBuild ? 'dist/ present (prod OK)  ' : 'dist/ absent (mode dev)  '}║`);
  console.log('╚══════════════════════════════════════════╝\n');
  if (!hasBuild) {
    console.log('  → Pour la prod: npm run build dans le frontend,');
    console.log(`    puis copier dist/ dans ce dossier server/\n`);
  }
});