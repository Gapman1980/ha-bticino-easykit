ARG BUILD_FROM
FROM ${BUILD_FROM}
ARG BUILD_VERSION

RUN apk add --no-cache nodejs npm ffmpeg

WORKDIR /app
COPY app/package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
# correzione alla libreria: profilo H.264 vero nella descrizione SDP (senza, iPhone mostra un fotogramma fisso)
COPY app/patch.js /app/patch.js
RUN node /app/patch.js
COPY app/setup.js app/index.js /app/
COPY run.sh /run.sh
RUN chmod +x /run.sh && echo "{\"versione\":\"${BUILD_VERSION}\"}" > /app/versione.json

ENTRYPOINT []
CMD ["/run.sh"]
