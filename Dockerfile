FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=7860 DATA_DIR=/tmp/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*
COPY server.js config.json index.html login.html ./
COPY public ./public
RUN mkdir -p /tmp/data/downloads && chown -R node:node /app /tmp/data
USER node
EXPOSE 7860
CMD ["node", "server.js"]
