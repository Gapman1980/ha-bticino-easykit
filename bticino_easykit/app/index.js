// BTicino EASY KIT Connected -> Home Assistant
// https://github.com/Gapman1980/ha-bticino-easykit  (MIT)
// Ponte basato sulla libreria MIT di Simone Di Maio: github.com/s-dimaio/BTicinoDoorEntry v2.1.0 (cloud BTicino, SIP mTLS).
// Progetto NON ufficiale, non affiliato a BTicino / Legrand.
// - squillo / chiamata persa / risposta altrove -> MQTT (binary_sensor, event, sensor)
// - pulsanti apertura serrature -> openGate
// - foto pulsantiera -> MQTT camera + http://127.0.0.1:<http_port>/foto.jpg
// - video live -> rtsp://127.0.0.1:<rtsp_port>/live (la chiamata video parte quando qualcuno guarda)
// I segreti (token, account SIP, certificati) stanno in /data/bticino e NON vengono mai scritti nel log.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const mqtt = require('mqtt');
const { BticinoAuthentication, openGate } = require('bticino-door-entry');

const OPT = (() => { try { return JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); } catch (_) { return {}; } })();
const CAM_INDEX = Number(OPT.camera_index || 1);
const FOTO_SQUILLO = OPT.foto_allo_squillo !== false;
const RTSP_PORT = Number(OPT.rtsp_port || 8564);
const HTTP_PORT = Number(OPT.http_port || 8098);
const DEBUG = !!OPT.debug;
const LANG = OPT.language === 'en' ? 'en' : 'it';
const INGRESS_PORT = 8095;
const VERSIONE = (() => { try { return require('/app/versione.json').versione; } catch (_) { return '?'; } })();

const DIR = '/data/bticino';
const T = 'bticino_easykit';         // radice topic MQTT
const DISC = 'homeassistant';
const UID = 'bticino_ek_';           // prefisso unique_id
const DEV = { identifiers: ['bticino_ek_hub'], name: LANG === 'en' ? 'BTicino door entry' : 'Videocitofono BTicino', manufacturer: 'BTicino', model: 'EASY KIT Connected', sw_version: VERSIONE };
const N = (it, en) => LANG === 'en' ? en : it;

const ora = () => new Date().toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' });
const log = (...a) => console.log(`[${ora()}]`, ...a);
const dbg = (...a) => { if (DEBUG) log('[debug]', ...a); };
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'serratura';

// ------------------------------------------------------------------ segreti
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (_) { return null; } };
const save = (f, o) => { const p = path.join(DIR, f); fs.writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 }); fs.chmodSync(p, 0o600); };

const tokens = load('tokens.json'), sip = load('sip_account.json'), certs0 = load('certs.json'), plant = load('plant.json');
if (!tokens || !sip || !certs0 || !plant) { log('ERRORE: mancano i dati di accesso: apri la pagina dell\'add-on e fai il login BTicino. Esco.'); process.exit(1); }
let certs = { cert: certs0.cert, key: certs0.key };
const CAM = (plant.modules.find(m => m.device === 'audioVideoTerminal' && m.deviceType !== 'IU') || {}).id;
const LOCKS = plant.modules.filter(m => m.device === 'lock').map(m => ({ id: m.id, name: m.name || 'Serratura', slug: slug(m.name) }));
log(`Impianto ${plant.plantId.slice(0, 8)}… pulsantiera ${CAM ? CAM.slice(0, 8) + '…' : 'NON TROVATA'}, serrature: ${LOCKS.map(l => l.name).join(', ') || 'nessuna'}`);

// ------------------------------------------------------------------ MQTT
let client = null;
const pub = (topic, payload, retain = true) => { if (client && client.connected) client.publish(topic, typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), { retain, qos: 1 }); };

function discovery() {
  const avail = { availability_topic: `${T}/stato`, payload_available: 'online', payload_not_available: 'offline' };
  const base = (comp, id, extra) => ({ unique_id: `${UID}${id}`, default_entity_id: `${comp}.videocitofono_${id}`, device: DEV, ...avail, ...extra });
  const cfg = [
    ['binary_sensor', 'squillo', { name: N('Squillo', 'Ringing'), state_topic: `${T}/squillo`, icon: 'mdi:bell-ring', payload_on: 'ON', payload_off: 'OFF' }],
    ['binary_sensor', 'connesso', { name: N('Connesso a BTicino', 'Connected to BTicino'), state_topic: `${T}/connesso`, device_class: 'connectivity', entity_category: 'diagnostic', payload_on: 'ON', payload_off: 'OFF' }],
    ['event', 'chiamata', { name: N('Chiamata', 'Call'), state_topic: `${T}/evento`, event_types: ['squillo', 'chiamata_persa', 'risposta_altrove'], icon: 'mdi:doorbell-video' }],
    ['sensor', 'ultimo_squillo', { name: N('Ultimo squillo', 'Last ring'), state_topic: `${T}/ultimo_squillo`, device_class: 'timestamp', icon: 'mdi:bell-badge' }],
    ['sensor', 'ultima_foto', { name: N('Ultima foto', 'Last snapshot'), state_topic: `${T}/ultima_foto`, device_class: 'timestamp', icon: 'mdi:camera-timer', entity_category: 'diagnostic' }],
    ['camera', 'foto', { name: N('Foto', 'Snapshot'), topic: `${T}/foto`, icon: 'mdi:doorbell-video' }],
    ['sensor', 'storico', { name: N('Storico squilli', 'Ring history'), state_topic: `${T}/storico/stato`, json_attributes_topic: `${T}/storico/attr`, icon: 'mdi:history' }],
    ['binary_sensor', 'occupato', { name: N('Conversazione in corso', 'Call in progress'), state_topic: `${T}/occupato`, icon: 'mdi:account-voice', payload_on: 'ON', payload_off: 'OFF' }],
    ['switch', 'anteprima', { name: N('Anteprima video allo squillo', 'Video preview while ringing'), command_topic: `${T}/cmd/anteprima`, state_topic: `${T}/anteprima`, payload_on: 'ON', payload_off: 'OFF', icon: 'mdi:eye-arrow-right', entity_category: 'config' }],
    ['button', 'aggiorna_foto', { name: N('Aggiorna foto', 'New snapshot'), command_topic: `${T}/cmd/foto`, payload_press: 'PRESS', icon: 'mdi:camera-retake' }],
  ];
  for (const l of LOCKS) cfg.push(['button', `apri_${l.slug}`, { name: `${N('Apri', 'Open')} ${l.name}`, command_topic: `${T}/cmd/apri/${l.slug}`, payload_press: 'PRESS', icon: /cancelletto|pedon|door|porta/.test(l.slug) ? 'mdi:gate-open' : 'mdi:boom-gate-up' }]);
  for (const [comp, id, extra] of cfg) pub(`${DISC}/${comp}/bticino_ek/${id}/config`, base(comp, id, extra));
}

async function avviaMqtt() {
  const r = await fetch('http://supervisor/services/mqtt', { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
  const m = (await r.json()).data;
  client = mqtt.connect(`${m.ssl ? 'mqtts' : 'mqtt'}://${m.host}:${m.port}`, {
    username: m.username, password: m.password, clientId: 'bticino_easykit_addon', reconnectPeriod: 5000,
    will: { topic: `${T}/stato`, payload: 'offline', retain: true, qos: 1 },
  });
  client.on('connect', () => {
    log('MQTT collegato');
    discovery();
    pub(`${T}/stato`, 'online');
    pub(`${T}/squillo`, 'OFF');
    pub(`${T}/connesso`, sipOk ? 'ON' : 'OFF');
    pub(`${T}/anteprima`, impost.anteprima ? 'ON' : 'OFF');
    pub(`${T}/occupato`, 'OFF');
    pubStorico();
    client.subscribe([`${T}/cmd/#`, `${DISC}/status`]);
  });
  client.on('message', (topic, msg) => {
    if (topic === `${DISC}/status` && String(msg) === 'online') { setTimeout(() => { discovery(); pub(`${T}/stato`, 'online'); }, 2000); return; }
    if (topic === `${T}/cmd/anteprima`) {
      impost.anteprima = String(msg).toUpperCase() === 'ON'; salvaImpost();
      pub(`${T}/anteprima`, impost.anteprima ? 'ON' : 'OFF');
      log(`👀 Anteprima video allo squillo: ${impost.anteprima ? 'ACCESA' : 'spenta'}`);
      return;
    }
    if (topic === `${T}/cmd/vivo`) { if (!MJ.vivoT) log('💓 popup aperto (battito ricevuto)'); MJ.vivoT = Date.now(); return; }
    if (topic === `${T}/cmd/foto`) return scattaFoto('pulsante').catch(() => {});
    const m = topic.match(/\/cmd\/apri\/(.+)$/);
    if (m) { const l = LOCKS.find(x => x.slug === m[1]); if (l) apri(l).catch(() => {}); }
  });
  client.on('error', (e) => log('MQTT errore:', e.message));
}

// ------------------------------------------------------------------ BTicino
const auth = new BticinoAuthentication({ initialTokens: tokens, proxyHost: '127.0.0.1', proxyPort: 18099, debug: false });
auth.on('tokenCreated', (t) => save('tokens.json', t));
auth.on('tokenRefreshed', (t) => { save('tokens.json', t); dbg('token rinnovato'); });
const salvaCert = (info) => {
  const p = info && info.prov ? info.prov : info;
  const cert = p && (p.certPEM || p.cert), key = p && (p.privateKeyPem || p.key || p.privateKey);
  if (cert && key) { certs = { cert, key }; save('certs.json', certs); log('Certificati rinnovati e salvati'); }
};
auth.on('certificatesRefreshed', salvaCert);

let sipOk = false, offTimer = null, ultimoInvite = { id: null, t: 0 };
const setSquillo = (on) => {
  pub(`${T}/squillo`, on ? 'ON' : 'OFF');
  clearTimeout(offTimer);
  if (on) offTimer = setTimeout(() => pub(`${T}/squillo`, 'OFF'), 60000);
};
auth.on('sip:registered', () => { if (!sipOk) log('In ascolto sul servizio BTicino'); sipOk = true; pub(`${T}/connesso`, 'ON'); });
auth.on('sip:disconnected', () => { log('Servizio BTicino scollegato (riprovo da solo)'); sipOk = false; pub(`${T}/connesso`, 'OFF'); });
auth.on('sip:error', (e) => log('Errore SIP:', e && e.message));
auth.on('sip:invite', (c) => {
  const id = c && c.callId, now = Date.now();
  if (id && id === ultimoInvite.id && now - ultimoInvite.t < 60000) return;
  ultimoInvite = { id, t: now };
  log('🔔 SQUILLO');
  setSquillo(true);
  pub(`${T}/evento`, { event_type: 'squillo' }, false);
  pub(`${T}/ultimo_squillo`, new Date().toISOString());
  storicoNuovo();
  // mentre squilla la pulsantiera e' occupata (486): la foto si scatta appena la chiamata finisce (max 40 s)
  if (FOTO_SQUILLO) { clearTimeout(fotoTimer); fotoAttesa = true; fotoTimer = setTimeout(fotoDopoChiamata, 40000); }
});
let fotoAttesa = false, fotoTimer = null;
function fotoDopoChiamata() {
  if (!fotoAttesa) return;
  fotoAttesa = false; clearTimeout(fotoTimer);
  // aspetto 3 s: se il popup e' aperto, a fine squillo il telefono si ricollega al video
  setTimeout(fotoDecidi, 3000);
}
function fotoDecidi() {
  // se qualcuno guarda il popup il video sta gia' partendo: la foto la prendo dal video (niente seconda chiamata)
  if (MJ.clienti.size) {
    MJ.fotoDaVideo = 4; // salta i primi fotogrammi
    clearTimeout(MJ.fotoRiserva);
    MJ.fotoRiserva = setTimeout(() => { if (MJ.fotoDaVideo) { MJ.fotoDaVideo = 0; scattaFoto('squillo').catch(() => {}); } }, 25000);
    return;
  }
  scattaFoto('squillo').catch(() => setTimeout(() => scattaFoto('squillo, 2o tentativo').catch(() => {}), 4000));
}
function salvaFotoDaVideo(jpg) {
  ultimaFoto = jpg;
  fs.writeFileSync(path.join(DIR, 'ultima_foto.jpg'), jpg);
  pub(`${T}/foto`, jpg);
  pub(`${T}/ultima_foto`, new Date().toISOString());
  log(`📸 Foto (squillo, dal video) ${Math.round(jpg.length / 1024)} kB`);
  storicoFoto(jpg);
}
// BTicino segnala "persa" anche quando si risponde dal monitor di casa: la scadenza vera arriva dopo ~30 s,
// quindi se la chiamata finisce prima di 25 s qualcuno ha risposto in casa.
auth.on('sip:callMissed', () => {
  const durata = ultimoInvite.t ? (Date.now() - ultimoInvite.t) / 1000 : 99;
  setSquillo(false);
  if (durata < 25) { log(`Risposto in casa (chiamata finita dopo ${durata.toFixed(0)} s)`); setOccupato(true); storicoEsito('risposta'); pub(`${T}/evento`, { event_type: 'risposta_altrove' }, false); }
  else { log(`Chiamata persa (dopo ${durata.toFixed(0)} s)`); storicoEsito('persa'); pub(`${T}/evento`, { event_type: 'chiamata_persa' }, false); }
  fotoDopoChiamata();
});
auth.on('sip:callAnswered', () => { log('Risposto da un altro apparecchio'); setSquillo(false); setOccupato(true); storicoEsito('risposta'); pub(`${T}/evento`, { event_type: 'risposta_altrove' }, false); fotoDopoChiamata(); });
// ------------------------------------------------------------------ STORICO SQUILLI (ultimi 10, con foto in /config/www)
// foto in /homeassistant/www/videocitofono/storico/<id casuale>.jpg -> /local/videocitofono/storico/<id>.jpg
const STO_DIR = '/homeassistant/www/videocitofono/storico';
const STO_FILE = path.join(DIR, 'storico.json');
let storico = (() => { try { return JSON.parse(fs.readFileSync(STO_FILE, 'utf8')); } catch (_) { return []; } })();
let stoCorrente = null;
try { fs.mkdirSync(STO_DIR, { recursive: true }); } catch (e) { log('Storico: cartella non scrivibile:', e.message); }
function stoSalva() {
  try { fs.writeFileSync(STO_FILE, JSON.stringify(storico), { mode: 0o600 }); } catch (_) {}
  pubStorico();
}
function pubStorico() {
  pub(`${T}/storico/stato`, String(storico.length));
  pub(`${T}/storico/attr`, { voci: storico.map(v => ({ t: v.t, esito: v.esito, foto: v.foto ? `/local/videocitofono/storico/${v.foto}` : null })) });
}
function storicoNuovo() {
  stoCorrente = { id: require('crypto').randomBytes(12).toString('hex'), t: new Date().toISOString(), esito: 'squillo', foto: null };
  storico.unshift(stoCorrente);
  for (const v of storico.splice(10)) { if (v.foto) { try { fs.unlinkSync(path.join(STO_DIR, v.foto)); } catch (_) {} } }
  stoSalva();
}
function storicoFoto(jpg) {
  if (!stoCorrente || stoCorrente.foto || Date.now() - Date.parse(stoCorrente.t) > 120000) return;
  try { const f = stoCorrente.id + '.jpg'; fs.writeFileSync(path.join(STO_DIR, f), jpg); stoCorrente.foto = f; stoSalva(); } catch (e) { log('Storico foto:', e.message); }
}
function storicoEsito(esito) {
  if (!stoCorrente || stoCorrente.esito !== 'squillo') return;
  stoCorrente.esito = esito; stoSalva();
}

// conversazione in corso (risposto dal monitor/app): la pulsantiera rifiuta il video (486) finche' non si chiude
let occupato = false, occTimer = null;
function setOccupato(on) {
  clearTimeout(occTimer);
  if (on !== occupato) { occupato = on; pub(`${T}/occupato`, on ? 'ON' : 'OFF'); log(on ? '🗣️ Conversazione in corso (pulsantiera occupata)' : '🗣️ Conversazione finita, pulsantiera libera'); }
  if (on) occTimer = setTimeout(() => setOccupato(false), 180000); // sicurezza: max 3 minuti
}
auth.on('sip:callEnded', () => { setSquillo(false); fotoDopoChiamata(); });
auth.on('sip:certificatesUpdated', () => log('Ascolto riavviato con i certificati nuovi'));

// lettore del canale SIP di ascolto: la libreria legge i messaggi a pezzi, qui li ricomponiamo interi (serve all'anteprima)
let tapSocket = null;
let tapBuf = '';
function attaccaRegistratore() {
  const l = auth.getSipListener();
  const s = l && l.socket;
  if (!s || s === tapSocket) return;
  tapSocket = s; tapBuf = '';
  s.on('data', (d) => {
    const txt = d.toString('latin1');
    // ricompongo i messaggi SIP interi (la libreria li legge a pezzi)
    tapBuf += txt;
    for (;;) {
      tapBuf = tapBuf.replace(/^(\r\n)+/, '');
      const i = tapBuf.indexOf('\r\n\r\n'); if (i < 0) break;
      const head = tapBuf.slice(0, i);
      const cl = Number((head.match(/^(?:content-length|l)\s*:\s*(\d+)/im) || [0, 0])[1]);
      if (tapBuf.length < i + 4 + cl) break;
      const msg = { head, body: tapBuf.slice(i + 4, i + 4 + cl), sock: s };
      tapBuf = tapBuf.slice(i + 4 + cl);
      try { messaggioSip(msg); } catch (e) { log('anteprima errore:', e.message); }
    }
    if (tapBuf.length > 200000) tapBuf = '';
  });
}

// ------------------------------------------------------------------ ANTEPRIMA VIDEO DURANTE LO SQUILLO (sperimentale)
// Come l'app ufficiale: alla chiamata in arrivo (con SDP) rispondo "183 Session Progress" con SDP (early media):
// la chiamata NON viene accettata, il monitor continua a suonare, ma il video arriva gia' durante lo squillo.
const BticinoSrtpDecryptor = require('bticino-door-entry/lib/video/BticinoSrtpDecryptor');
const IMPOST = path.join(DIR, 'impostazioni.json');
const impost = (() => { try { return JSON.parse(fs.readFileSync(IMPOST, 'utf8')); } catch (_) { return { anteprima: true }; } })();
const salvaImpost = () => { try { fs.writeFileSync(IMPOST, JSON.stringify(impost), { mode: 0o600 }); } catch (_) {} };
const ANT = { callId: null, invite: null, sock: null, timer: null };
const righe = (head, nome) => head.split('\r\n').filter(r => new RegExp(`^(${nome})\\s*:`, 'i').test(r));
const valore = (head, nome) => { const r = righe(head, nome)[0]; return r ? r.slice(r.indexOf(':') + 1).trim() : ''; };
function rispostaSip(inv, code, text, extra = [], body = '') {
  const l = auth.getSipListener();
  const tag = (l && l._localTag) || 'ha' + Date.now();
  let to = valore(inv.head, 'to|t'); if (!/;tag=/i.test(to)) to += `;tag=${tag}`;
  const out = [`SIP/2.0 ${code} ${text}`, ...righe(inv.head, 'via|v'), ...righe(inv.head, 'record-route'),
    `From: ${valore(inv.head, 'from|f')}`, `To: ${to}`, `Call-ID: ${valore(inv.head, 'call-id|i')}`, `CSeq: ${valore(inv.head, 'cseq')}`,
    ...extra, `Content-Length: ${Buffer.byteLength(body, 'latin1')}`, '', body].join('\r\n');
  inv.sock.write(Buffer.from(out, 'latin1'));
}
function messaggioSip(m) {
  const prima = m.head.split('\r\n')[0];
  const metodo = (prima.match(/^([A-Z]+) /) || [])[1];
  const callId = valore(m.head, 'call-id|i');
  if (metodo === 'INVITE' && /m=video/.test(m.body)) {
    if (!impost.anteprima) return;
    anteprimaAvvia(m, callId).catch((e) => { log('Anteprima non avviata:', e && e.message); anteprimaFine('errore'); });
  } else if ((metodo === 'CANCEL' || metodo === 'BYE') && ANT.callId && callId === ANT.callId) {
    if (metodo === 'CANCEL' && ANT.invite) { try { rispostaSip(ANT.invite, 487, 'Request Terminated'); } catch (_) {} }
    anteprimaFine(metodo === 'CANCEL' ? 'fine squillo' : 'chiamata chiusa');
  }
}
async function anteprimaAvvia(inv, callId) {
  if (ANT.callId) return;
  const sdp = inv.body;
  const vIdx = sdp.indexOf('m=video');
  const vSez = sdp.slice(vIdx);
  const ip = ((vSez.match(/c=IN IP4 ([0-9.]+)/) || sdp.match(/c=IN IP4 ([0-9.]+)/)) || [])[1];
  const porta = Number((vSez.match(/m=video (\d+)/) || [])[1]);
  const cr = vSez.match(/a=crypto:(\d+) (AES_CM_128_HMAC_SHA1_80) inline:([A-Za-z0-9+/=]+)/) || vSez.match(/a=crypto:(\d+) (AES_CM_128_HMAC_SHA1_32) inline:([A-Za-z0-9+/=]+)/);
  if (!ip || !porta || !cr) throw new Error('SDP senza video/chiave utilizzabile');
  const [, tagCr, suite, chiave] = cr;
  ANT.callId = callId; ANT.invite = inv; ANT.t0 = Date.now();
  const s = auth.getVideoStreamer() || auth.createVideoStreamer(sip, certs, { idleTimeoutMs: 1000, debug: false });
  if (s._activeStream) { try { await s.stopStream(); } catch (_) {} s._boundPortCache = null; }
  await s.rtspServer.start();
  await s._bindLocalUdpSocket();
  s._remoteRelayIp = ip; s._remoteVideoPort = porta; s._negotiatedVideoPt = 96;
  s.srtpDecryptor = new BticinoSrtpDecryptor(chiave, { suite });
  s._activeCameraId = CAM; s._activeCameraIndex = CAM_INDEX; s._rtpState = null; s._receivedUdpCount = 0; s._decryptedRtpCount = 0;
  s._autoRestartCount = 999; // durante l'anteprima niente richiamate automatiche
  s._activeStream = true;
  s._boundPortCache = s.rtspServer._boundPort;
  const ipLoc = s._getLocalIp(), pv = s._localVideoPort;
  const risposta = [
    'v=0', `o=${s.username} 558 1 IN IP4 ${ipLoc}`, 's=Talk', `c=IN IP4 ${ipLoc}`, 't=0 0',
    `m=audio ${pv > 2 ? pv - 2 : 7076} RTP/SAVP 96`, 'a=rtpmap:96 speex/8000', 'a=inactive',
    `a=crypto:${tagCr} ${suite} inline:${s._clientInlineKey}`,
    `m=video ${pv} RTP/SAVP 96`, 'a=rtpmap:96 H264/90000', 'a=fmtp:96 profile-level-id=42801F', 'a=recvonly',
    `a=crypto:${tagCr} ${suite} inline:${s._clientInlineKey}`, 'a=rtcp-fb:96 nack pli', 'a=rtcp-fb:96 ccm fir', ''].join('\r\n');
  rispostaSip(inv, 183, 'Session Progress', [`Contact: <sip:${s.username}@${ipLoc};transport=tls>`, 'Content-Type: application/sdp', `User-Agent: HomeAssistant-BTicino/${VERSIONE}`], risposta);
  s._startRtpKeepAlive();
  log(`👀 Anteprima video avviata durante lo squillo (183, relay ${ip}:${porta})`);
  clearTimeout(ANT.timer); ANT.timer = setTimeout(() => anteprimaFine('tempo scaduto'), 45000);
  // foto dello squillo presa subito dall'anteprima
  setTimeout(() => {
    if (!ANT.callId) return;
    fotoAttesa = false; clearTimeout(fotoTimer);
    scattaFoto('squillo, anteprima').catch(() => { fotoAttesa = true; });
  }, 2500);
}
async function anteprimaFine(motivo) {
  if (!ANT.callId) return;
  const durata = ((Date.now() - (ANT.t0 || Date.now())) / 1000).toFixed(0);
  ANT.callId = null; ANT.invite = null; clearTimeout(ANT.timer);
  const s = auth.getVideoStreamer();
  let n = 0;
  if (s && s.srtpDecryptor) {
    n = s._decryptedRtpCount || 0;
    try { await s._teardownResources(); } catch (_) {}
    s._activeStream = false; s.srtpDecryptor = null; s._boundPortCache = null; s._autoRestartCount = 0;
  }
  log(`👀 Anteprima chiusa (${motivo}) dopo ${durata} s${n ? `, ${n} pacchetti video ricevuti` : ''}`);
}
setInterval(attaccaRegistratore, 2000);

async function avviaAscolto() {
  for (;;) {
    try {
      const l = auth.getSipListener() || auth.createSipListener(sip, certs, { keepAlive: true, autoReconnect: true });
      await l.connect();
      attaccaRegistratore();
      await l.register();
      return;
    } catch (e) {
      log('Collegamento al servizio BTicino fallito:', e && e.message, '- riprovo fra 30 s');
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

// coda: una operazione alla volta verso il gateway (foto, apertura)
let coda = Promise.resolve();
const inCoda = (fn) => { const p = coda.then(fn, fn); coda = p.catch(() => {}); return p; };

let ultimaFoto = (() => { try { return fs.readFileSync(path.join(DIR, 'ultima_foto.jpg')); } catch (_) { return null; } })();
function scattaFoto(motivo) {
  return inCoda(async () => {
    if (!CAM) throw new Error('pulsantiera non trovata');
    const t0 = Date.now();
    try {
      const jpg = await auth.captureCameraSnapshot(CAM, { cameraIndex: CAM_INDEX, forceFresh: true, timeoutMs: 20000 });
      ultimaFoto = jpg;
      fs.writeFileSync(path.join(DIR, 'ultima_foto.jpg'), jpg);
      pub(`${T}/foto`, jpg);
      pub(`${T}/ultima_foto`, new Date().toISOString());
      log(`📸 Foto (${motivo}) ${Math.round(jpg.length / 1024)} kB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (String(motivo).startsWith('squillo')) storicoFoto(jpg);
      return jpg;
    } catch (e) { log(`Foto (${motivo}) non riuscita:`, e && e.message); throw e; }
  });
}

function apri(l) {
  return inCoda(async () => {
    const t0 = Date.now();
    log(`🚪 Apro ${l.name}...`);
    try {
      await openGate(l.id, plant.plantId, certs.cert, certs.key, sip, { debug: false });
      log(`🚪 ${l.name}: comando inviato in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      pub(`${T}/aperto`, { serratura: l.slug, quando: new Date().toISOString() }, false);
    } catch (e) { log(`${l.name}: apertura non riuscita:`, e && e.message); throw e; }
  });
}

// ------------------------------------------------------------------ HTTP (foto) solo su 127.0.0.1
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/foto.jpg') {
    try {
      const jpg = u.searchParams.has('nuova') ? await scattaFoto('http') : ultimaFoto;
      if (!jpg) { res.writeHead(404); return res.end('nessuna foto'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(jpg);
    } catch (e) { res.writeHead(503); return res.end('foto non disponibile'); }
  }
  if (u.pathname === '/mjpeg') return mjpegCliente(req, res);
  if (u.pathname === '/stato') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ connesso: sipOk, serrature: LOCKS.map(l => l.name), foto: !!ultimaFoto })); }
  res.writeHead(404); res.end();
}).listen(HTTP_PORT, '127.0.0.1', () => log(`Foto su http://127.0.0.1:${HTTP_PORT}/foto.jpg`));

// ------------------------------------------------------------------ MJPEG (compatibile con tutto, iPhone compreso)
// un solo ffmpeg legge l'RTSP locale e produce JPEG; ogni fotogramma va a tutti i telefoni collegati
const { spawn } = require('child_process');
const MJ = { proc: null, clienti: new Set(), buf: Buffer.alloc(0), stop: null, ultimo: null, ultimoT: 0, fotoDaVideo: 0, fotoRiserva: null };
const parteJpeg = (jpg) => Buffer.concat([Buffer.from(`--fotogramma\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`), jpg, Buffer.from('\r\n')]);
function mjpegAvvia() {
  if (MJ.proc) return;
  log('🎞️ MJPEG avviato');
  MJ.proc = spawn('ffmpeg', ['-loglevel', 'error', '-nostdin', '-threads', '1', '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
    '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:${RTSP_PORT}/live`, '-flush_packets', '1',
    '-an', '-fps_mode', 'passthrough', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  MJ.proc.stdout.on('data', (d) => {
    MJ.buf = Buffer.concat([MJ.buf, d]);
    for (;;) {
      const a = MJ.buf.indexOf(Buffer.from([0xff, 0xd8])); if (a < 0) { MJ.buf = Buffer.alloc(0); return; }
      const b = MJ.buf.indexOf(Buffer.from([0xff, 0xd9]), a + 2); if (b < 0) { if (a > 0) MJ.buf = MJ.buf.subarray(a); return; }
      const jpg = MJ.buf.subarray(a, b + 2); MJ.buf = MJ.buf.subarray(b + 2);
      MJ.ultimo = Buffer.from(jpg); MJ.ultimoT = Date.now();
      if (MJ.fotoDaVideo && --MJ.fotoDaVideo === 0) { clearTimeout(MJ.fotoRiserva); salvaFotoDaVideo(MJ.ultimo); }
      const parte = parteJpeg(jpg);
      for (const r of MJ.clienti) { try { r.write(parte); } catch (_) {} }
    }
  });
  MJ.proc.stderr.on('data', (d) => dbg('ffmpeg:', String(d).trim()));
  MJ.proc.on('exit', (c) => {
    log('🎞️ MJPEG fermato', c ? `(codice ${c})` : '');
    MJ.proc = null; MJ.buf = Buffer.alloc(0);
    if (MJ.clienti.size) setTimeout(() => { if (MJ.clienti.size) mjpegAvvia(); }, 2000); // es. pausa del rinnovo chiamata
  });
}
// conversazione in corso e popup aperto: riprovo il video ogni 5 s; appena la pulsantiera e' libera riparte
setInterval(() => {
  if (!occupato || !MJ.vivoT || Date.now() - MJ.vivoT > 3000 || avvio) return;
  portaVideo().catch(() => {});
}, 5000);
// battito del popup: se il popup ha mandato battiti e smette per 3 s, chiudo tutto anche se iPhone tiene appeso il collegamento
setInterval(() => {
  if (MJ.vivoT && Date.now() - MJ.vivoT > 3000) {
    MJ.vivoT = 0;
    if (MJ.clienti.size || MJ.proc) {
      log('💤 popup chiuso (niente battito): chiudo video e pulsantiera');
      for (const r of MJ.clienti) { try { r.end(); } catch (_) {} }
      MJ.clienti.clear();
      chiudiVideo(true);
    }
  }
}, 1000);
async function chiudiVideo(forza) {
  if (MJ.clienti.size && !forza) return;
  if (MJ.proc) MJ.proc.kill('SIGTERM');
  const s = auth.getVideoStreamer();
  if (s && s._boundPortCache) {
    try { await s.stopStream(); s._boundPortCache = null; log('📴 Pulsantiera chiusa (popup chiuso)'); } catch (e) { log('Chiusura video:', e && e.message); }
  }
}
function mjpegCliente(req, res) {
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=fotogramma', 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache', Connection: 'close' });
  // primo fotogramma subito: l'ultimo del video se recente, altrimenti l'ultima foto (niente riquadro nero)
  const primo = (MJ.ultimo && Date.now() - MJ.ultimoT < 60000) ? MJ.ultimo : (ultimaFoto || MJ.ultimo);
  if (primo) res.write(parteJpeg(primo));
  MJ.clienti.add(res);
  clearTimeout(MJ.stop);
  // senza battito del popup entro 5 s (es. iPhone che si ricollega da solo a popup chiuso) chiudo questo collegamento
  setTimeout(() => {
    if (MJ.clienti.has(res) && (!MJ.vivoT || Date.now() - MJ.vivoT > 3000)) {
      log('🎞️ collegamento senza popup aperto: chiuso');
      MJ.clienti.delete(res); try { res.end(); } catch (_) {}
      if (!MJ.clienti.size) chiudiVideo();
    }
  }, 5000);
  log(`🎞️ telefono collegato al video (${MJ.clienti.size})`);
  mjpegAvvia();
  req.on('close', () => {
    MJ.clienti.delete(res);
    log(`🎞️ telefono scollegato dal video (${MJ.clienti.size})`);
    // popup chiuso: fermo subito video e chiamata alla pulsantiera (1 s di margine per i ricollegamenti istantanei)
    if (!MJ.clienti.size) { clearTimeout(MJ.stop); MJ.stop = setTimeout(chiudiVideo, 1000); }
  });
}

// ------------------------------------------------------------------ RTSP fisso: avvia la chiamata video quando qualcuno guarda
let avvio = null;
async function portaVideo() {
  const s = auth.getVideoStreamer() || auth.createVideoStreamer(sip, certs, { idleTimeoutMs: 1000, debug: false });
  if (s.rtspServer && s.rtspServer.isRunning() && s._boundPortCache) return s._boundPortCache;
  if (!avvio) {
    avvio = (async () => {
      const t0 = Date.now();
      const r = await s.startStream(CAM, occupato ? { cameraIndex: CAM_INDEX, maxDialAttempts: 1 } : { cameraIndex: CAM_INDEX });
      setOccupato(false);
      // aspetta SPS/PPS (max 4 s) cosi' la descrizione SDP ai lettori contiene il profilo vero
      for (let i = 0; i < 20 && !(s.rtspServer && s.rtspServer._spropParameterSets); i++) await new Promise(z => setTimeout(z, 200));
      s._boundPortCache = r.port;
      log(`🎥 Video live avviato in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return r.port;
    })().finally(() => { avvio = null; });
  }
  return avvio;
}
auth.on('video:stopped', () => { const s = auth.getVideoStreamer(); if (s) s._boundPortCache = null; log('🎥 Video live fermato (nessuno guarda)'); });
auth.on('video:error', (e) => log('Errore video:', e && e.message));
net.createServer((sock) => {
  sock.pause();
  portaVideo().then((port) => {
    const up = net.connect(port, '127.0.0.1', () => { sock.pipe(up); up.pipe(sock); sock.resume(); });
    const chiudi = () => { sock.destroy(); up.destroy(); };
    up.on('error', chiudi); sock.on('error', chiudi); up.on('close', chiudi); sock.on('close', chiudi);
  }).catch((e) => { log('Video live non avviato:', e && e.message); sock.destroy(); });
}).listen(RTSP_PORT, '127.0.0.1', () => log(`Video live su rtsp://127.0.0.1:${RTSP_PORT}/live`));

// ------------------------------------------------------------------ pagina dell'add-on (Ingress): stato + nuovo login
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
http.createServer(async (req, res) => {
  const ra = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (!['172.30.32.2', '127.0.0.1'].includes(ra)) { res.writeHead(403); return res.end(); }  // solo dal proxy Ingress di HA
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname.endsWith('/rifai_login')) {
    for (const f of ['tokens.json', 'sip_account.json', 'certs.json', 'plant.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch (_) {} }
    log('Nuovo login richiesto dalla pagina dell\'add-on: riavvio');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<meta http-equiv="refresh" content="8;url=./"><p style="font-family:sans-serif">${N('Riavvio in corso… tra pochi secondi comparirà il link per il login.', 'Restarting… the login link will appear in a few seconds.')}</p>`);
    setTimeout(() => fetch('http://supervisor/addons/self/restart', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }).catch(() => process.exit(0)), 500);
    return;
  }
  const riga = (k, v, c) => `<tr><td>${k}</td><td style="color:${c || '#fff'}">${v}</td></tr>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e3e9f3;margin:0;padding:20px}h1{font-size:22px}
.box{max-width:640px;border-radius:18px;padding:16px 18px;background:#141c38;box-shadow:inset 0 0 0 1px #00E5FF55}
td{padding:6px 10px;border-bottom:1px solid #ffffff14}button{margin-top:14px;padding:10px 16px;border-radius:12px;border:1px solid #FF5252;background:#2a0b12;color:#fff;font-weight:700}</style></head><body>
<div class="box"><h1>🔔 BTicino EASY KIT <small style="font-size:12px;color:#8a96aa">v${esc(VERSIONE)}</small></h1><table>
${riga(N('Servizio BTicino', 'BTicino service'), sipOk ? N('collegato', 'connected') : N('non collegato', 'not connected'), sipOk ? '#69F0AE' : '#FF5252')}
${riga(N('Pulsantiera', 'Entrance panel'), CAM ? N('trovata', 'found') : N('NON trovata', 'NOT found'))}
${riga(N('Serrature', 'Locks'), esc(LOCKS.map(l => l.name).join(', ') || '-'))}
${riga(N('Anteprima allo squillo', 'Preview while ringing'), impost.anteprima ? 'ON' : 'OFF')}
${riga(N('Telecamera video', 'Video camera'), 'camera.videocitofono_video (MJPEG)')}
</table>
<form method="post" action="rifai_login" onsubmit="return confirm('${N('Rifare il login BTicino? I dati di accesso salvati verranno cancellati.', 'Log in to BTicino again? Saved credentials will be deleted.')}')"><button>${N('Rifai il login BTicino', 'Log in to BTicino again')}</button></form>
</div></body></html>`);
}).listen(INGRESS_PORT, '0.0.0.0', () => log(`Pagina dell'add-on (Ingress) pronta`));

// ------------------------------------------------------------------ telecamera video MJPEG creata da sola in HA (una volta)
async function creaTelecamera() {
  const H = { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${HTTP_PORT}/mjpeg`;
  try {
    const voci = await (await fetch('http://supervisor/core/api/config/config_entries/entry', { headers: H })).json();
    if ((voci || []).some(e => e.domain === 'mjpeg' && /videocitofono|door entry|bticino/i.test(e.title || ''))) return;
    let f = await (await fetch('http://supervisor/core/api/config/config_entries/flow', { method: 'POST', headers: H, body: JSON.stringify({ handler: 'mjpeg' }) })).json();
    f = await (await fetch(`http://supervisor/core/api/config/config_entries/flow/${f.flow_id}`, { method: 'POST', headers: H,
      body: JSON.stringify({ name: 'Videocitofono video', mjpeg_url: url, still_image_url: `http://127.0.0.1:${HTTP_PORT}/foto.jpg`, verify_ssl: false }) })).json();
    log(f.type === 'create_entry' ? '🎥 Telecamera "Videocitofono video" creata in HA (camera.videocitofono_video)' : `Telecamera video non creata: ${JSON.stringify(f.errors || f.type)}`);
  } catch (e) { log('Telecamera video non creata:', e && e.message); }
}

// ------------------------------------------------------------------ avvio
(async () => {
  await auth.authenticate();
  auth.setSipAccount(sip);
  auth.setCertificates(certs.cert, certs.key);
  await avviaMqtt();
  await avviaAscolto();
  if (ultimaFoto) pub(`${T}/foto`, ultimaFoto);
  setTimeout(creaTelecamera, 5000);
})().catch((e) => { log('ERRORE avvio:', e && e.message); process.exit(1); });

const fine = async () => { pub(`${T}/stato`, 'offline'); try { await auth.shutdown(); } catch (_) {} setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', fine);
process.on('SIGINT', fine);
process.on('unhandledRejection', (e) => log('Errore non gestito:', e && e.message));
