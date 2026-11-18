FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY services/core/package.json services/core/
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY services/core/src services/core/src
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --chown=node:node package.json ./
COPY --chown=node:node database/migrations database/migrations
RUN install -d -m 0700 -o node -g node /media/input /media/output
COPY --chown=node:node docs/frontend-player-ar.html docs/player-live.js docs/player-poster.webp docs/studio-sample.mp4 docs/
USER node
CMD ["node","dist/server.js"]
