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

// CORS — accepte localhost + tout réseau local (192.168.x, 10.x, 172.16-31.x)
function isLocalOrigin(origin) {
  if (!origin) return true; // requête directe (ex: Postman, curl)
  try {
    const host = new URL(origin).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    // Plages IP privées RFC-1918
    if (/^192\.168\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  } catch { return false; }
}

const corsOptions = {
  origin: '*',
  methods: ['GET','POST','DELETE','PUT','PATCH'],
  credentials: false,
  allowedHeaders: ['Content-Type']
};

const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// ─── DOSSIERS ─────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
// directory contenant le build frontend. Par défaut 'dist' dans le serveur, mais pendant dev
// on peut construire dans ../audit/dist et le serveur prendra automatiquement cette version.
let BUILD_DIR   = path.join(__dirname, 'dist');
const altBuild = path.join(__dirname, '..', 'audit', 'dist');
// Préférer la version construite dans ../audit/dist si elle existe (utile en développement)
if (fs.existsSync(altBuild)) {
  BUILD_DIR = altBuild;
}
const MISSIONS_FILE = path.join(DATA_DIR, 'missions.json');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');

[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── SERVIR LE BUILD VITE ──────────────────────────────────────
if (fs.existsSync(BUILD_DIR)) {
  app.use(express.static(BUILD_DIR));
  console.log('[BUILD] Servir le build Vite depuis', BUILD_DIR);
}

// ─── PERSISTENCE JSON ─────────────────────────────────────────
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let missions = loadJSON(MISSIONS_FILE, {});
let connectedUsers = {};

// ─── UTILISATEURS AUDITEURS (base de données fichier) ─────────
// Format: [ { email, nom, role, type:'Createur'|'Auditeur'|'Admin', actif, missions:[], createdAt } ]
function loadUsers() { return loadJSON(USERS_FILE, []); }
function saveUsers(u) { saveJSON(USERS_FILE, u); }

// Enregistrer ou mettre a jour un utilisateur automatiquement
function upsertUser(email, nom, type) {
  const users = loadUsers();
  const emailLow = email.toLowerCase().trim();
  const existing = users.find(u => u.email.toLowerCase() === emailLow);
  if (existing) {
    if (!existing.nom && nom) existing.nom = nom;
    // Normaliser role/type pour coherence
    const currentType = (existing.type || existing.role || 'Auditeur').toLowerCase();
    const isAlreadyCreator = currentType === 'createur' || currentType === 'créateur' || currentType === 'admin';
    if (!isAlreadyCreator && type) { existing.type = type; existing.role = type; }
    // S'assurer que les deux champs existent
    if (!existing.type) existing.type = existing.role || 'Auditeur';
    if (!existing.role) existing.role = existing.type || 'Auditeur';
    existing.lastSeen = new Date().toISOString();
    saveUsers(users);
    return existing;
  } else {
    const newUser = { email: emailLow, nom: nom||emailLow.split('@')[0], type: type||'Auditeur', role: type||'Auditeur', actif: true, missions: [], createdAt: new Date().toISOString() };
    users.push(newUser);
    saveUsers(users);
    console.log('[USER AUTO-INSCRIT] ' + emailLow + ' type=' + (type||'Auditeur'));
    return newUser;
  }
}

// Initialiser avec un exemple si vide
if (!fs.existsSync(USERS_FILE)) {
  saveUsers([
    { email: 'admin@auditmaster.dev', nom: 'Administrateur', type: 'Admin', role: 'Admin', actif: true, missions: [], createdAt: new Date().toISOString() }
  ]);
  console.log('[INIT] Fichier users.json cree');
}

// ─── LICENCES DÉVELOPPEUR (base de données fichier) ───────────
// Format: [ { code, client, maxUses, uses, actif, createdAt } ]
function loadLicenses() { return loadJSON(LICENSES_FILE, []); }
function saveLicenses(l) { saveJSON(LICENSES_FILE, l); }

// ─── MISSIONS (persistence) ────────────────────────────────────
function saveMissions(m) { saveJSON(MISSIONS_FILE, m); }

// Initialiser avec des licences exemples si vide
if (!fs.existsSync(LICENSES_FILE)) {
  saveLicenses([
    { code: 'AUDIT-2025-MASTER-PRO', client: 'Licence Pro',    maxUses: 999, uses: 0, actif: true, createdAt: new Date().toISOString() },
    { code: 'AUDIT-2025-DEMO-001',   client: 'Demo',           maxUses: 5,   uses: 0, actif: true, createdAt: new Date().toISOString() },
    { code: 'AUDIT-CABINET-ALPHA',   client: 'Cabinet Alpha',  maxUses: 50,  uses: 0, actif: true, createdAt: new Date().toISOString() },
    { code: 'AUDIT-CABINET-BETA',    client: 'Cabinet Beta',   maxUses: 50,  uses: 0, actif: true, createdAt: new Date().toISOString() },
  ]);
  console.log('[INIT] Fichier licenses.json cree avec licences exemples');
}

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
  const users = loadUsers();
  return Object.values(connectedUsers)
    .filter(u => u.missionCode === missionCode)
    .map(u => {
      const dbUser = users.find(x => x.email && x.email.toLowerCase() === (u.userEmail||'').toLowerCase());
      const role = dbUser ? (dbUser.role || dbUser.type || 'Auditeur') : (u.isCreator ? 'Créateur' : 'Auditeur');
      return { name: u.userName, email: u.userEmail||'', isCreator: u.isCreator, role };
    });
}

// ─── PAGE D'ACCUEIL ───────────────────────────────────────────
app.get('/', (req, res) => {
  const indexHtml = path.join(BUILD_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  const ip = getLocalIP();
  const total = Object.keys(missions).length;
  const users = loadUsers();
  const licenses = loadLicenses();
  const PORT = process.env.PORT || 3001;
  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>AUDIT MASTER - Serveur</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#070b14;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}.wrap{max-width:600px;width:90%;padding:24px 0}h1{font-size:26px;font-weight:900;color:#0ea5e9;margin-bottom:4px}.sub{color:#64748b;font-size:13px;margin-bottom:28px}.card{background:#111827;border:1px solid #1f2d45;border-radius:14px;padding:24px;margin-bottom:14px}.row{display:flex;justify-content:space-between;margin-bottom:7px;font-size:13px}.row span{color:#64748b}code{font-family:monospace;color:#0ea5e9;background:#0ea5e915;padding:1px 7px;border-radius:4px}.badge{display:inline-flex;align-items:center;gap:6px;background:#10b98120;color:#10b981;border:1px solid #10b98140;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600}</style>
</head><body><div class="wrap">
<h1>⚖️ AUDIT MASTER</h1>
<div class="sub">Serveur API actif &nbsp; <span class="badge">${total} mission(s)</span> <span class="badge" style="background:#a78bfa20;color:#a78bfa;border-color:#a78bfa40">${users.length} auditeurs</span> <span class="badge" style="background:#f59e0b20;color:#f59e0b;border-color:#f59e0b40">${licenses.length} licences</span></div>
<div class="card">
  <div class="row"><span>Local</span><code>localhost:${PORT}</code></div>
  <div class="row"><span>Reseau</span><code>${ip}:${PORT}</code></div>
  <div class="row"><span>Missions</span><code>${total}</code></div>
  <div class="row"><span>Auditeurs inscrits</span><code>${users.length} (data/users.json)</code></div>
  <div class="row"><span>Licences actives</span><code>${licenses.filter(l=>l.actif).length} (data/licenses.json)</code></div>
</div>
<div class="card" style="background:#f59e0b10;border-color:#f59e0b30;font-size:12px;color:#f59e0b;line-height:1.8">
  <strong>Gestion des acces :</strong><br>
  Auditeurs : editez <code>data/users.json</code><br>
  Licences : editez <code>data/licenses.json</code><br>
  Redemarrer le serveur apres modification des fichiers
</div>
</div></body></html>`);
});

// ═══════════════════════════════════════════════════════════════
// API LICENCES
// ═══════════════════════════════════════════════════════════════

// Verifier une licence
app.post('/api/license/verify', (req, res) => {
  const { licenseCode } = req.body;
  if (!licenseCode) return res.status(400).json({ valid: false, error: 'Code requis' });
  const licenses = loadLicenses();
  const lic = licenses.find(l => l.code.toUpperCase() === licenseCode.trim().toUpperCase() && l.actif);
  if (!lic) return res.json({ valid: false, error: 'Code de licence invalide ou inactif' });
  if (lic.uses >= lic.maxUses) return res.json({ valid: false, error: 'Ce code a atteint sa limite d\'utilisation (' + lic.maxUses + ')' });
  console.log('[LICENCE OK] ' + licenseCode + ' — ' + lic.client + ' (' + (lic.uses+1) + '/' + lic.maxUses + ')');
  res.json({ valid: true, client: lic.client });
});

// Lister les licences (admin)
app.get('/api/licenses', (req, res) => {
  res.json({ licenses: loadLicenses() });
});

// Ajouter une licence
app.post('/api/licenses', (req, res) => {
  const { code, client, maxUses } = req.body;
  if (!code || !client) return res.status(400).json({ error: 'code et client requis' });
  const licenses = loadLicenses();
  if (licenses.find(l => l.code.toUpperCase() === code.toUpperCase())) return res.status(400).json({ error: 'Code deja existant' });
  licenses.push({ code: code.toUpperCase(), client, maxUses: maxUses||50, uses: 0, actif: true, createdAt: new Date().toISOString() });
  saveLicenses(licenses);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// API UTILISATEURS AUDITEURS
// ═══════════════════════════════════════════════════════════════

// Lister les auditeurs
app.get('/api/users', (req, res) => {
  const users = loadUsers();
  // Enrichir avec les missions associees
  const enriched = users.map(u => ({
    ...u,
    missionsCreees: Object.values(missions).filter(m => (m.createdByEmail||'').toLowerCase() === u.email.toLowerCase()).map(m => ({ code: m.code, name: m.missionName, createdAt: m.createdAt })),
    missionsMembre: Object.values(missions).filter(m => (m.auditData?.perimeter?.equipe||[]).some(mb => (mb.email||'').toLowerCase() === u.email.toLowerCase())).map(m => ({ code: m.code, name: m.missionName })),
  }));
  res.json({ users: enriched });
});

// Ajouter un utilisateur
app.post('/api/users', (req, res) => {
  const { email, nom, type, role } = req.body;
  if (!email || !nom) return res.status(400).json({ error: 'email et nom requis' });
  const users = loadUsers();
  const emailLow = email.toLowerCase().trim();
  if (users.find(u => u.email.toLowerCase() === emailLow)) return res.status(400).json({ error: 'Email deja inscrit' });
  const userType = type || role || 'Auditeur';
  users.push({ email: emailLow, nom: nom.trim(), type: userType, role: userType, actif: true, missions: [], createdAt: new Date().toISOString() });
  saveUsers(users);
  console.log('[USER AJOUTE] ' + emailLow + ' — ' + nom + ' [' + userType + ']');
  res.json({ success: true });
});

// Modifier un utilisateur (type, nom, actif)
app.patch('/api/users/:email', (req, res) => {
  const users = loadUsers();
  const emailLow = req.params.email.toLowerCase();
  const u = users.find(u => u.email.toLowerCase() === emailLow);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { nom, type, actif } = req.body;
  if (nom !== undefined) u.nom = nom;
  if (type !== undefined) { u.type = type; u.role = type; }
  if (actif !== undefined) u.actif = actif;
  u.updatedAt = new Date().toISOString();
  saveUsers(users);
  console.log('[USER MODIFIE] ' + emailLow + ' => ' + JSON.stringify({nom,type,actif}));
  res.json({ success: true, user: u });
});

// Supprimer un utilisateur
app.delete('/api/users/:email', (req, res) => {
  const before = loadUsers();
  const after = before.filter(u => u.email.toLowerCase() !== req.params.email.toLowerCase());
  if (before.length === after.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
  saveUsers(after);
  console.log('[USER SUPPRIME] ' + req.params.email);
  res.json({ success: true });
});

// Verifier si email autorise
app.post('/api/users/verify', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ valid: false, error: 'Email requis' });
  const users = loadUsers();
  const u = users.find(u => u.email.toLowerCase() === email.toLowerCase().trim() && u.actif);
  if (!u) return res.json({ valid: false, error: 'Email non autorise. Contactez l\'administrateur.' });
  res.json({ valid: true, nom: u.nom, type: u.type, role: u.role });
});

// ═══════════════════════════════════════════════════════════════
// API MISSIONS
// ═══════════════════════════════════════════════════════════════

// Creer une mission
app.post('/api/mission/create', (req, res) => {
  const { missionName, userName, userEmail, customCode, licenseCode } = req.body;
  if (!missionName || !userName) return res.status(400).json({ error: 'Champs requis manquants' });

  // Verifier la licence
  if (licenseCode) {
    const licenses = loadLicenses();
    const lic = licenses.find(l => l.code.toUpperCase() === licenseCode.trim().toUpperCase() && l.actif);
    if (!lic) return res.status(403).json({ error: 'Code de licence invalide' });
    if (lic.uses >= lic.maxUses) return res.status(403).json({ error: 'Licence expiree' });
    lic.uses++;
    saveLicenses(licenses);
  }

  let code = customCode
    ? customCode.toUpperCase().replace(/[^A-Z0-9\-]/g, '')
    : generateCode();

  if (missions[code]) return res.status(400).json({ error: 'Ce code existe deja' });

  missions[code] = {
    code, missionName,
    createdBy: userName,
    createdByEmail: userEmail || '',
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
      notes:[], connectionLogs:[]
    }
  };
  saveMissions(missions);
  // Enregistrer automatiquement le créateur dans users.json
  if (userEmail) upsertUser(userEmail, userName, 'Createur');
  console.log('[MISSION CREEE] ' + code + ' par ' + userName + ' (' + (userEmail||'') + ')');
  res.json({ success: true, code, missionName, createdBy: userName });
});

// Verifier acces a une mission — connexion par EMAIL uniquement
app.post('/api/mission/verify', (req, res) => {
  const { code, email } = req.body;
  if (!code || !email) return res.json({ success: false, error: 'Code de mission et email requis' });

  const mission = missions[code];
  if (!mission) return res.json({ success: false, error: 'Code de mission invalide ou inexistant' });

  const emailLow = email.toLowerCase().trim();

  // Verifier dans users.json (accepte "role" ET "type" pour compatibilite)
  const users = loadUsers();
  const globalUser = users.find(u => u.email.toLowerCase() === emailLow && u.actif);
  if (!globalUser) {
    console.log('[ACCES REFUSE] Email absent de users.json: ' + emailLow);
    return res.json({ success: false, error: 'Email non autorisé. Demandez à l\'administrateur de vous inscrire dans la base des auditeurs.' });
  }

  // Normaliser : lire "type" ou "role" (les deux sont valides)
  const userType = (globalUser.type || globalUser.role || 'Auditeur').toLowerCase();
  const isCreatorByUsers = userType === 'createur' || userType === 'créateur' || userType === 'creator';

  // Verifier si createur : par createdByEmail de la mission OU par type dans users.json
  const isCreatorByMission = (mission.createdByEmail || '').toLowerCase() === emailLow;
  const isCreator = isCreatorByMission || isCreatorByUsers;

  if (isCreator) {
    // Si createdByEmail était vide, le mettre a jour maintenant
    if (!mission.createdByEmail && isCreatorByUsers) {
      mission.createdByEmail = emailLow;
      mission.createdBy = globalUser.nom || emailLow.split('@')[0];
      saveMissions(missions);
      console.log('[MISSION] createdByEmail mis a jour: ' + emailLow + ' => ' + code);
    }
    const userName = globalUser.nom || mission.createdBy || emailLow.split('@')[0];
    upsertUser(emailLow, userName, 'Createur');
    console.log('[ACCES OK] ' + emailLow + ' => mission ' + code + ' [CREATEUR]');
    return res.json({ success: true, missionName: mission.missionName, createdBy: mission.createdBy || userName, isCreator: true, userName, createdAt: mission.createdAt });
  }

  // Verifier que l'email est dans l'equipe de cette mission
  const equipe = (mission.auditData && mission.auditData.perimeter && mission.auditData.perimeter.equipe) || [];
  const membreEquipe = equipe.find(mb => mb.email && mb.email.toLowerCase().trim() === emailLow);
  if (!membreEquipe) {
    console.log('[ACCES REFUSE] Email absent de l\'equipe mission: ' + emailLow + ' code:' + code);
    return res.json({ success: false, error: 'Email non inscrit dans cette mission. Le créateur doit vous ajouter dans Périmètre → Équipe.' });
  }

  const userName = globalUser.nom || membreEquipe.nom || emailLow.split('@')[0];
  upsertUser(emailLow, userName, 'Auditeur');
  console.log('[ACCES OK] ' + emailLow + ' => mission ' + code + ' (auditeur)');
  res.json({ success: true, missionName: mission.missionName, createdBy: mission.createdBy, isCreator: false, userName, createdAt: mission.createdAt });
});

// Charger une mission
app.get('/api/mission/:code', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  // Migration : s assurer que chaque message a un channel
  if (mission.auditData && mission.auditData.conversations && Array.isArray(mission.auditData.conversations.messages)) {
    mission.auditData.conversations.messages = mission.auditData.conversations.messages.map(m => {
      if (!m.channel) m.channel = 'general';
      return m;
    });
  }
  res.json({
    success: true, auditData: mission.auditData,
    meta: { missionName: mission.missionName, createdBy: mission.createdBy, createdAt: mission.createdAt, lastUpdate: mission.lastUpdate }
  });
});

// Sauvegarder
app.post('/api/mission/:code/save', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  const { auditData, savedBy } = req.body;
  missions[req.params.code].auditData = auditData;
  missions[req.params.code].lastUpdate = new Date().toISOString();
  saveMissions(missions);
  io.to(req.params.code).emit('full-sync', { auditData, savedBy, timestamp: new Date().toISOString() });
  res.json({ success: true });
});

// Supprimer mission
app.delete('/api/mission/:code', (req, res) => {
  const { userEmail } = req.body;
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  const emailLow = (userEmail || '').toLowerCase().trim();
  if ((mission.createdByEmail || '').toLowerCase() !== emailLow) {
    return res.status(403).json({ error: 'Seul le createur peut supprimer cette mission' });
  }
  const uploadDir = path.join(UPLOADS_DIR, req.params.code);
  if (fs.existsSync(uploadDir)) fs.rmSync(uploadDir, { recursive: true, force: true });
  delete missions[req.params.code];
  saveMissions(missions);
  io.to(req.params.code).emit('mission-deleted', { by: mission.createdBy });
  console.log('[MISSION SUPPRIMEE] ' + req.params.code);
  res.json({ success: true });
});

// Changer le code d acces
app.post('/api/mission/:code/change-code', (req, res) => {
  const { newCode, userEmail, userName } = req.body;
  const oldCode = req.params.code;
  const mission = missions[oldCode];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const emailLow = (userEmail || '').toLowerCase().trim();
  const creatorEmail = (mission.createdByEmail || '').toLowerCase();
  if (creatorEmail && creatorEmail !== emailLow) {
    return res.status(403).json({ error: 'Seul le createur peut modifier le code' });
  }
  if (!newCode || newCode.trim().length < 6) return res.status(400).json({ error: 'Code trop court (min 6 caracteres)' });

  const formatted = newCode.toUpperCase().replace(/[^A-Z0-9\-]/g, '').substring(0, 11);
  if (missions[formatted] && formatted !== oldCode) return res.status(400).json({ error: 'Code deja utilise' });

  missions[formatted] = { ...mission, code: formatted, lastUpdate: new Date().toISOString() };
  if (formatted !== oldCode) delete missions[oldCode];
  saveMissions(missions);
  io.to(oldCode).emit('code-changed', { newCode: formatted, by: userName || 'Createur' });
  console.log('[CODE MODIFIE] ' + oldCode + ' => ' + formatted);
  res.json({ success: true, newCode: formatted, oldCode });
});

// Lister les missions
app.get('/api/missions', (req, res) => {
  const list = Object.values(missions).map(m => ({
    code: m.code, missionName: m.missionName, createdBy: m.createdBy,
    createdAt: m.createdAt, lastUpdate: m.lastUpdate,
    online: getUsersInMission(m.code).length
  }));
  res.json({ missions: list });
});

// Rapport de connexions
app.get('/api/mission/:code/logs', (req, res) => {
  const mission = missions[req.params.code];
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  const logs = (mission.auditData && mission.auditData.connectionLogs) || [];
  const format = req.query.format || 'json';

  // Enrichir les logs
  const enriched = logs.map(l => {
    const join = new Date(l.join);
    const leave = l.leave ? new Date(l.leave) : new Date();
    const durSec = Math.round((leave - join) / 1000);
    const hrs = Math.floor(durSec / 3600);
    const mins = Math.floor((durSec % 3600) / 60);
    const secs = durSec % 60;
    const durText = (hrs > 0 ? hrs + 'h ' : '') + (mins > 0 ? mins + 'm ' : '') + secs + 's';
    return { userName: l.userName, userEmail: l.userEmail || '', join: l.join, leave: l.leave || null, durationSeconds: durSec, durationText: durText.trim() };
  });

  if (format === 'csv') {
    const lines = ['Auditeur,Email,Connexion,Deconnexion,Duree(sec),Duree'];
    enriched.forEach(l => lines.push(
      '"' + l.userName + '","' + l.userEmail + '","' + l.join + '","' + (l.leave||'En cours') + '",' + l.durationSeconds + ',"' + l.durationText + '"'
    ));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="logs_' + req.params.code + '.csv"');
    return res.send('\uFEFF' + lines.join('\n')); // BOM UTF-8
  }
  res.json({ logs: enriched });
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
    url: 'http://' + ip + ':' + PORT + '/uploads/' + code + '/' + f.filename,
    uploadedAt: new Date().toISOString(), uploadedBy: req.body.user || 'Auditeur'
  }));
  res.json({ success: true, files });
});

// ─── SPA FALLBACK ────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexHtml = path.join(BUILD_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  res.status(404).json({ error: 'Route inconnue' });
});

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {

  socket.on('join', ({ missionCode, userName, userEmail, isCreator }) => {
    socket.join(missionCode);
    connectedUsers[socket.id] = { userName, userEmail: userEmail||'', missionCode, isCreator: !!isCreator };

    // Journal de connexion
    if (missions[missionCode] && missions[missionCode].auditData) {
      if (!missions[missionCode].auditData.connectionLogs) missions[missionCode].auditData.connectionLogs = [];
      missions[missionCode].auditData.connectionLogs.push({ userName, userEmail: userEmail||'', isCreator: !!isCreator, join: new Date().toISOString(), leave: null });
      missions[missionCode].lastUpdate = new Date().toISOString();
      saveMissions(missions);
    }

    const users = getUsersInMission(missionCode);
    io.to(missionCode).emit('users-update', users);
    socket.to(missionCode).emit('user-joined', { name: userName, time: new Date().toISOString() });
    const role = isCreator ? '[CREATEUR]' : '[AUDITEUR]';
    console.log('[CONNECTE] ' + role + ' ' + userName + ' <' + (userEmail||'?') + '> => mission ' + missionCode + ' (' + users.length + ' en ligne)');
  });

  socket.on('field-update', ({ missionCode, path: fieldPath, value, userName }) => {
    if (missions[missionCode]) {
      applyFieldUpdate(missions[missionCode].auditData, fieldPath, value);
      missions[missionCode].lastUpdate = new Date().toISOString();
      socket.to(missionCode).emit('field-updated', { path: fieldPath, value, by: userName, at: new Date().toISOString() });
    }
  });

  socket.on('section-update', ({ missionCode, section, data, userName }) => {
    if (missions[missionCode]) {
      missions[missionCode].auditData[section] = data;
      missions[missionCode].lastUpdate = new Date().toISOString();
      socket.to(missionCode).emit('section-updated', { section, data, by: userName, at: new Date().toISOString() });
    }
  });

  socket.on('save-request', ({ missionCode, auditData, userName }) => {
    if (!missions[missionCode]) {
      console.warn('[SAVE-REQUEST] Mission not found:', missionCode);
      return;
    }
    missions[missionCode].auditData = auditData;
    missions[missionCode].lastUpdate = new Date().toISOString();
    saveMissions(missions);
    io.to(missionCode).emit('saved', { by: userName, at: new Date().toISOString() });
    const msgCount = auditData?.conversations?.messages?.length || 0;
    console.log('[SAUVEGARDE] ' + missionCode + ' par ' + userName + ' (' + msgCount + ' messages)');
  });

  // Chat
  socket.on('chat-send', (msg, ack) => {
    if (!msg || !msg.missionCode) { if (ack) ack({ success: false }); return; }
    if (!msg.channel) msg.channel = 'general';
    if (!msg.id) msg.id = Date.now() + Math.random();

    if (missions[msg.missionCode] && missions[msg.missionCode].auditData) {
      if (!missions[msg.missionCode].auditData.conversations) missions[msg.missionCode].auditData.conversations = { messages: [] };
      const msgs = missions[msg.missionCode].auditData.conversations.messages;
      if (!msgs.some(m => m.id === msg.id)) {
        msgs.push(msg);
        missions[msg.missionCode].lastUpdate = new Date().toISOString();
        saveMissions(missions);
        console.log('[CHAT-SAVE] Message saved for', msg.missionCode, '| Total messages:', msgs.length);
      }
    } else {
      console.warn('[CHAT-SEND] Mission auditData not found for:', msg.missionCode);
    }

    if (msg.channel === 'general') {
      // Envoyer aux AUTRES seulement (l'expediteur a deja ajoute localement)
      socket.to(msg.missionCode).emit('chat-message', msg);
    } else {
      // Message privé : envoyer AU DESTINATAIRE seulement
      // L'expéditeur a déjà le message localement (setChatMessages dans sendMsg)
      const target = msg.channel;
      Object.entries(connectedUsers).forEach(([sockId, u]) => {
        if (u.missionCode === msg.missionCode && u.userName === target) {
          io.to(sockId).emit('chat-message', msg);
        }
      });
    }
    console.log('[CHAT] ' + msg.auteur + ' => ' + msg.channel + ' | ' + msg.missionCode);
    if (ack) ack({ success: true });
  });

  socket.on('chat-delete', (data, ack) => {
    const { missionCode, messageId } = data;
    if (!missionCode || !messageId) { if (ack) ack({ success: false }); return; }
    if (missions[missionCode] && missions[missionCode].auditData && missions[missionCode].auditData.conversations) {
      const msgs = missions[missionCode].auditData.conversations.messages;
      const idx = msgs.findIndex(m => m.id === messageId);
      if (idx >= 0) {
        msgs.splice(idx, 1);
        missions[missionCode].lastUpdate = new Date().toISOString();
        saveMissions(missions);
        io.to(missionCode).emit('chat-deleted', { messageId });
      }
    }
    if (ack) ack({ success: true });
  });

  socket.on('chat-typing', (data) => {
    const { missionCode, channel, userName, isTyping } = data;
    socket.to(missionCode).emit('user-typing', { channel: channel || 'general', userName, isTyping });
  });

  socket.on('user-typing', (data) => {
    const { channel, userName, isTyping, missionCode } = data;
    if (!missionCode) return;
    socket.to(missionCode).emit('user-typing', { channel: channel || 'general', userName, isTyping });
  });

  socket.on('disconnect', () => {
    const user = connectedUsers[socket.id];
    if (user) {
      const code = user.missionCode;
      if (missions[code] && missions[code].auditData && Array.isArray(missions[code].auditData.connectionLogs)) {
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
      console.log('[DECONNECTE] ' + user.userName + ' (' + code + ')');
    }
  });
});

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
  const licenses = loadLicenses();
  const users = loadUsers();
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    AUDIT MASTER — Serveur Temps Reel     ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Local  : http://localhost:' + PORT + '           ║');
  console.log('║  Reseau : http://' + ip + ':' + PORT + '     ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Missions    : ' + Object.keys(missions).length.toString().padEnd(26) + '║');
  console.log('║  Auditeurs   : ' + users.length.toString().padEnd(26) + '║');
  console.log('║  Licences    : ' + licenses.filter(l=>l.actif).length.toString().padEnd(26) + '║');
  console.log('║  Build Vite  : ' + (hasBuild ? 'dist/ OK (prod)          ' : 'absent (mode dev)        ') + '║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('\n  Auditeurs : data/users.json');
  console.log('  Licences  : data/licenses.json\n');
});
