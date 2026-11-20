// BTicino EASY KIT -> Home Assistant: PRIMO ACCESSO
// Se mancano i dati di accesso: mostra nella pagina dell'add-on (Ingress) il pulsante "Accedi a BTicino",
// fa da tramite alla pagina di login ufficiale BTicino/Legrand (la password la scrive l'utente, non viene salvata),
// poi sceglie l'impianto con il videocitofono, registra "Home Assistant" come nuovo dispositivo e salva token e certificati.
// Esce con codice 0 quando e' tutto pronto (run.sh poi avvia index.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BticinoAuthentication } = require('bticino-door-entry');

const OPT = (() => { try { return JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); } catch (_) { return {}; } })();
const LANG = OPT.language === 'en' ? 'en' : 'it';
const N = (it, en) => LANG === 'en' ? en : it;
const DIR = '/data/bticino';
const FILES = ['tokens.json', 'sip_account.json', 'certs.json', 'plant.json'];
const INGRESS_PORT = 8095;
const LOGIN_PORT = Number(OPT.login_port || 8096);
const log = (...a) => console.log(`[setup]`, ...a);

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
if (FILES.every(f => fs.existsSync(path.join(DIR, f)))) process.exit(0);

const save = (f, o) => { const p = path.join(DIR, f); fs.writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 }); fs.chmodSync(p, 0o600); };
const ipLan = () => {
  if (OPT.login_host) return OPT.login_host;
  for (const [nome, l] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|hassio|veth|br-|lo)/.test(nome)) continue;
    for (const i of l || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
};
const HOST = ipLan();
const stato = { fase: 'avvio', link: null, errore: null, dettaglio: '' };

// ---------------- pagina dell'add-on
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
http.createServer((req, res) => {
  const ra = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (!['172.30.32.2', '127.0.0.1'].includes(ra)) { res.writeHead(403); return res.end(); }
  let corpo = '';
  if (stato.fase === 'login' && stato.link) {
    corpo = `<p>${N('Per collegare il videocitofono serve un accesso al tuo account BTicino / Legrand (lo stesso dell\'app <b>Door Entry EASYKIT</b>).', 'To connect your door entry system, log in to your BTicino / Legrand account (the same one used by the <b>Door Entry EASYKIT</b> app).')}</p>
<p><a class="btn" href="${esc(stato.link)}" target="_blank" rel="noopener">🔑 ${N('Accedi a BTicino', 'Log in to BTicino')}</a></p>
<p class="nota">${N('Si apre la pagina di login ufficiale BTicino/Legrand attraverso Home Assistant: la password la scrivi tu e non viene salvata. Il link funziona solo dalla rete di casa. Dopo il login torna qui: la pagina si aggiorna da sola.', 'The official BTicino/Legrand login page opens through Home Assistant: you type your password, it is not stored. The link only works from your home network. After logging in, come back here: this page refreshes by itself.')}</p>`;
  } else if (stato.fase === 'errore') {
    corpo = `<p style="color:#FF5252">⚠️ ${esc(stato.errore)}</p><p class="nota">${N('Controlla il registro dell\'add-on e riavvialo per riprovare.', 'Check the add-on log and restart it to try again.')}</p>`;
  } else {
    corpo = `<p>⏳ ${esc(stato.dettaglio || N('Preparazione…', 'Preparing…'))}</p>`;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e3e9f3;margin:0;padding:20px}.box{max-width:640px;border-radius:18px;padding:16px 18px;background:#141c38;box-shadow:inset 0 0 0 1px #FFB30066}
h1{font-size:22px}.btn{display:inline-block;padding:12px 20px;border-radius:14px;background:#00E676;color:#05210f;font-weight:800;text-decoration:none;box-shadow:0 0 18px #00E67688}.nota{font-size:13px;color:#9fb0c4}</style></head>
<body><div class="box"><h1>🔔 BTicino EASY KIT – ${N('primo accesso', 'first setup')}</h1>${corpo}</div></body></html>`);
}).listen(INGRESS_PORT, '0.0.0.0');

// ---------------- login + registrazione
(async () => {
  // se il login era gia' stato fatto (es. registrazione interrotta) riuso il token: niente secondo login
  const tokSalvati = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'tokens.json'), 'utf8')); } catch (_) { return null; } })();
  const auth = new BticinoAuthentication({ initialTokens: tokSalvati, proxyHost: HOST, proxyPort: LOGIN_PORT, timeoutMs: 60 * 60 * 1000, debug: false });
  auth.on('loginUrlCreated', ({ loginUrl }) => {
    stato.fase = 'login'; stato.link = loginUrl;
    log(N('Login richiesto: apri la pagina dell\'add-on (Apri interfaccia web) e premi "Accedi a BTicino".', 'Login required: open the add-on page (Open web UI) and press "Log in to BTicino".'));
  });
  let tokens = null;
  auth.on('tokenCreated', (t) => { tokens = t; save('tokens.json', t); });
  auth.on('tokenRefreshed', (t) => { tokens = t; save('tokens.json', t); });
  const r = await auth.authenticate();
  tokens = tokens || (r && r.tokens);
  if (tokens) save('tokens.json', tokens);
  stato.fase = 'lavoro'; stato.dettaglio = N('Login riuscito. Cerco il videocitofono nel tuo account…', 'Logged in. Looking for your door entry system…');
  log(stato.dettaglio);

  const api = auth.createApiClient();
  const plants = await api.getPlants();
  const elenco = Array.isArray(plants) ? plants : (plants && plants.plants) || [];
  const candidati = [];
  for (const p of elenco) {
    let mods = [];
    try { mods = await api.getModules(p.id) || []; } catch (_) { continue; }
    if (mods.some(m => m.device === 'gateway') && mods.some(m => m.device === 'audioVideoTerminal')) candidati.push({ p, mods });
  }
  if (OPT.plant_id) candidati.sort((a, b) => (b.p.id === OPT.plant_id) - (a.p.id === OPT.plant_id));
  else candidati.sort((a, b) => String(b.p.activationDate || '').localeCompare(String(a.p.activationDate || '')));
  log(N(`Impianti nell'account: ${elenco.length}, con videocitofono: ${candidati.length}`, `Plants in the account: ${elenco.length}, with a door entry system: ${candidati.length}`));
  if (!candidati.length) throw new Error(N('Nessun videocitofono trovato nell\'account BTicino (prima collegalo con l\'app Door Entry EASYKIT).', 'No door entry system found in the BTicino account (pair it with the Door Entry EASYKIT app first).'));
  const { p, mods } = candidati[0];
  const gw = mods.find(m => m.device === 'gateway');
  stato.dettaglio = N(`Registro "Home Assistant" sull'impianto "${p.name || ''}"…`, `Registering "Home Assistant" on plant "${p.name || ''}"…`);
  log(stato.dettaglio);

  let sip = null, certs = null;
  auth.on('deviceRegistered', (x) => { if (x && x.result) sip = x.result; });
  const salvaCert = (info) => { const q = info && info.prov ? info.prov : info; const c = q && (q.certPEM || q.cert), k = q && (q.privateKeyPem || q.key || q.privateKey); if (c && k) certs = { cert: c, key: k }; };
  auth.on('certificatesCreated', salvaCert);
  const res = await auth.registerDevice({ plantId: p.id, gatewayId: gw.id, async: false, clientName: 'Home Assistant' });
  if (res && res.result) sip = res.result;
  if (res && res.prov) salvaCert(res.prov);
  if (!certs && auth.getCurrentCertificates()) salvaCert(auth.getCurrentCertificates());
  if (!sip) sip = await api.getCurrentSipAccount(gw.id);
  if (!sip || !certs) throw new Error(N('Registrazione non completata (account SIP o certificati mancanti).', 'Registration not completed (missing SIP account or certificates).'));
  save('sip_account.json', sip);
  save('certs.json', certs);
  save('plant.json', { plantId: p.id, gatewayId: gw.id, modules: mods.map(m => ({ id: m.id, device: m.device, deviceType: m.deviceType, name: m.name, tags: m.tags })) });
  const locks = mods.filter(m => m.device === 'lock').map(m => m.name).join(', ');
  log(N(`Fatto! Serrature: ${locks || '-'}. Avvio il videocitofono…`, `Done! Locks: ${locks || '-'}. Starting…`));
  await auth.shutdown();
  process.exit(0);
})().catch((e) => {
  stato.fase = 'errore'; stato.errore = e && e.message;
  log('ERRORE:', e && e.message);
  setTimeout(() => process.exit(1), 60000);   // lascio la pagina d'errore visibile un minuto
});
