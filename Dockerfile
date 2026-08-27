FROM node:20-alpine
WORKDIR /app

# server.js + worker.js + deps (load-env + models fallback)
COPY package.json server.js worker.js load-env.mjs freebuff-models.json ./

# Create credentials dir (mounted at runtime)
RUN mkdir -p /app/credentials && chown -R node:node /app

USER node
EXPOSE 8787

CMD ["node", "server.js"]