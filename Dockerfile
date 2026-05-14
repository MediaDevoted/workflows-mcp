# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
ARG NPM_TOKEN
WORKDIR /app
COPY package*.json .npmrc ./
# NPM_TOKEN is required: it lets `npm install` pull @mediadevoted/* scoped
# packages from GitHub Packages. Comes from the compose build args (which
# Komodo periphery sources from the stack's .env).
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ARG NPM_TOKEN
WORKDIR /app
ENV NODE_ENV=production \
    WORKFLOWS_MCP_TRANSPORT=http \
    WORKFLOWS_MCP_PORT=3030
COPY package*.json .npmrc ./
RUN npm install --omit=dev && npm cache clean --force && rm -f .npmrc
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKFLOWS_MCP_PORT||3030)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
