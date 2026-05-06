# Multi-stage build. Default CMD runs the HTTP MCP server, since stdio doesn't
# make sense in a container — for stdio override CMD with: node dist/mcp.js
#
# Build:  docker build -t appkettle .
# Run:    docker run --rm -p 8080:8080 \
#           -e MCP_HTTP_HOST=0.0.0.0 \
#           -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
#           appkettle
# UDP discovery requires --network host on Linux; macOS/Windows use bridge OK.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8080
USER node
CMD ["node", "dist/mcp-http.js"]
