FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY bedrock-ws.mjs ./

ENV NODE_ENV=production
EXPOSE 8443
USER node
CMD ["node", "bedrock-ws.mjs"]
