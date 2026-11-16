# Ranker API image: Node 24, compiled with tsc, run as `node dist/server.js`.
# Base image pinned by digest; bump deliberately (docs/EXTERNAL-REVIEW.md §3).

FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
ENV NODE_ENV=production \
    RANKER_HOST=0.0.0.0 \
    RANKER_PORT=8080
WORKDIR /app
# The service reaches its database through an in-process client (src/db/client.ts,
# docs/decisions/0001-in-process-postgres-client.md): no psql in this image.
# Runtime npm dependencies only, from the lockfile; package.json carries "type": "module".
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# dist/contracts/index.js resolves the contract documents from /app/contracts.
COPY contracts ./contracts
# The merged schema migrations, applied by the deploy/ PreSync Job (copied out
# of this image, so schema and service always ship together).
COPY db/migrations ./db/migrations
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
