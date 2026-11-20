// Correzioni alla libreria bticino-door-entry 2.1.0 applicate in fase di build (Dockerfile).
const fs = require('fs');
const sost = (file, coppie) => {
  const f = require.resolve(`bticino-door-entry/${file}`);
  let s = fs.readFileSync(f, 'utf8');
  for (const [a, b] of coppie) {
    const trovato = a instanceof RegExp ? a.test(s) : s.includes(a);
    if (!trovato) { console.error(`PATCH ${file}: testo non trovato (${a}), libreria cambiata?`); process.exit(1); }
    s = s.replace(a, b);
  }
  fs.writeFileSync(f, s);
  console.log('PATCH applicata a', file);
};

// 1) Il server RTSP dichiarava sempre profile-level-id=42801F, ma la pulsantiera manda 42401E (Constrained Baseline 3.0):
//    Safari/iPhone mostrava solo il primo fotogramma. Ora il profilo viene letto dallo SPS vero.
sost('lib/video/BticinoRtspLoopbackServer.js', [
  ["this._spropParameterSets = `${sps.toString('base64')},${pps.toString('base64')}`;",
   "this._spropParameterSets = `${sps.toString('base64')},${pps.toString('base64')}`;\n    this._profileLevelId = sps.subarray(1, 4).toString('hex').toUpperCase();"],
  ['profile-level-id=42801F${sprop}', "profile-level-id=${this._profileLevelId || '42E01E'}${sprop}"],
]);

// 2) registerDevice: la variabile `existing` era dichiarata dentro il blocco if(gatewayId) ma usata fuori
//    -> "existing is not defined" quando l'account SIP esiste gia' (secondo login). La porto fuori dal blocco.
sost('lib/auth/BticinoRegisterDevice.js', [
  // (i file della libreria hanno fine riga Windows CRLF; "if (gatewayId)" compare due volte: prendo quello prima di "Fetch SIP accounts")
  [/( *)if \(gatewayId\) \{(\r?\n\s*\/\/ Fetch SIP accounts)/, '$1let existing = null;\n$1if (gatewayId) {$2'],
  ['const existing = sipAccounts.find(acc =>', 'existing = sipAccounts.find(acc =>'],
]);
