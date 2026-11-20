# BTicino EASY KIT

## Primo avvio / First start
1. Avvia l'add-on e apri la sua pagina (**Apri interfaccia web**). / Start the add-on and open its page (**Open web UI**).
2. Premi **🔑 Accedi a BTicino** e fai il login con l'account dell'app *Door Entry EASYKIT* (*Accedi*, non *Iscriviti*). / Press **🔑 Log in to BTicino** and log in with your *Door Entry EASYKIT* account (*Sign in*, not *Sign up*).
3. L'add-on trova il kit, si registra come "Home Assistant" e si avvia. / The add-on finds your kit, registers as "Home Assistant" and starts.

Il link di login funziona solo dalla rete di casa. Se mostra un indirizzo sbagliato imposta l'opzione `login_host` con l'IP di Home Assistant.
The login link only works from your home network. If it shows a wrong address set `login_host` to your Home Assistant IP.

## Pagina dell'add-on / Add-on page
Mostra lo stato (servizio BTicino, pulsantiera, serrature, anteprima) e il pulsante **Rifai il login BTicino**.
Shows the status (BTicino service, entrance panel, locks, preview) and the **Log in to BTicino again** button.

## Opzioni / Options
| Opzione | Default | |
|---|---|---|
| `language` | `it` | nomi entità e pagina / entity names and page (it, en) |
| `camera_index` | `1` | canale telecamera / camera channel |
| `foto_allo_squillo` | `true` | foto di chi suona / snapshot on ring |
| `rtsp_port`, `http_port` | `8564`, `8098` | porte interne (solo 127.0.0.1) / internal ports (127.0.0.1 only) |
| `login_port` | `8096` | porta della pagina di login (solo primo accesso) / login page port (first setup only) |
| `login_host` | – | IP di HA in casa se quello automatico è sbagliato / HA LAN IP if the automatic one is wrong |
| `plant_id` | – | solo con più kit nell'account / only with more kits in the account |

Esempi di card e automazioni: https://github.com/Gapman1980/ha-bticino-easykit/tree/main/examples
