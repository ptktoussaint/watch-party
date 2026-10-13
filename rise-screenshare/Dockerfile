FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=4173 DATA_FILE=/app/data/data.json
VOLUME /app/data
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4173/api/health || exit 1
CMD ["node", "server.js"]
