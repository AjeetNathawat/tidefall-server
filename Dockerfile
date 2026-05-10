# Tidefall — multiplayer Catan game server (Socket.IO)
FROM node:20-alpine

WORKDIR /app

# Install deps first to leverage Docker layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy the rest of the source.
COPY . .

# HF Spaces routes traffic to PORT (default 7860).
ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
