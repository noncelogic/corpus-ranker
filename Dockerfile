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
# The service has no runtime dependencies; package.json carries "type": "module".
COPY package.json ./
COPY --from=build /app/dist ./dist
# dist/contracts/index.js resolves the contract documents from /app/contracts.
COPY contracts ./contracts
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
