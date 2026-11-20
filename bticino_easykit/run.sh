#!/bin/sh
# 1) primo accesso (login BTicino dalla pagina dell'add-on) se mancano i dati; 2) videocitofono
node /app/setup.js || exit 1
exec node /app/index.js
