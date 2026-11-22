# Changelog

## 1.1.0
- **Storico chiamate: elimina una chiamata o tutte** / **Call history: delete one call or all of them** – nuovi comandi MQTT / new MQTT commands
  `bticino_easykit/cmd/storico/elimina` (payload = id), `…/svuota`, `…/visto`. Anche la foto viene cancellata / the photo is deleted too.
- **Chiamate non viste** / **Unseen calls**: attributo `nuove` su `sensor.videocitofono_storico` e `nuova` / `id` su ogni voce.
- Esempi aggiornati / Updated examples: popup con le ultime 5 chiamate, foto a schermo intero, cestino e scopa con conferma;
  mini card con il pallino giallo delle chiamate non viste (si azzera aprendo il popup) / popup with the last 5 calls, full-screen
  photo, trash and broom with confirmation; mini card with the yellow unseen-calls badge (cleared when the popup opens).

## 1.0.0
- Prima versione pubblica / First public release.
- Login guidato dalla pagina dell'add-on, scelta automatica dell'impianto / Guided login from the add-on page, automatic plant selection.
- Squillo, chiamata persa, risposto in casa, conversazione in corso / Ring, missed call, answered at home, call in progress.
- Video live MJPEG (anche durante lo squillo), foto, storico ultimi 10 squilli / Live MJPEG video (also while ringing), snapshots, last 10 rings history.
- Apertura serrature / Lock opening.
- Telecamera `camera.videocitofono_video` creata automaticamente / camera created automatically.
- Correzioni alla libreria BTicinoDoorEntry 2.1.0 (profilo H.264, secondo login) / Fixes to BTicinoDoorEntry 2.1.0 (H.264 profile, second login).
