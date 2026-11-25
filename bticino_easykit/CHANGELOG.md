# Changelog

## 1.1.1
- **Foto dello squillo mai "verde"** / **No more "green" ring snapshots** – i primi fotogrammi del video (prima del fotogramma chiave H.264) potevano uscire verdi/corrotti: ora ogni foto viene validata e un fotogramma rovinato non viene mai salvato né inviato, resta l'ultima foto buona. / the first video frames (before the H.264 keyframe) could come out green/corrupt: every snapshot is now validated and a broken frame is never saved or sent, the last good photo is kept.
- Anteprima dello squillo: riprova fino a 6 volte a prendere un fotogramma pulito, poi scatta a fine chiamata. / Ring preview: retries up to 6 times to grab a clean frame, then takes the photo at the end of the call.
- A pulsantiera occupata (risposto dal monitor, SIP 486) non viene più forzato uno scatto: si attende che si liberi. / While the door station is busy (answered at the monitor, SIP 486) no snapshot is forced: it waits until it's free.

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
