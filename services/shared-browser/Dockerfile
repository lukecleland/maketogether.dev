FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
COPY server.mjs protocol.mjs egress.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
