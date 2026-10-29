FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies and Remotion requirements for Debian
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libfreetype6 \
    libharfbuzz0b \
    libgbm1 \
    libdrm2 \
    libasound2 \
    libatk-bridge2.0-0 \
    libxshmfence1 \
    ca-certificates \
    fonts-freefont-ttf \
    ffmpeg \
    mesa-utils \
    libgl1-mesa-dri \
    libcairo2 \
    libpango1.0-0 \
    fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY fonts-local.conf /etc/fonts/local.conf

COPY package.json package-lock.json* ./
# Copy prisma schema before npm install so the postinstall `prisma generate` succeeds
COPY prisma ./prisma
RUN npm install
# Remotion renders with its own chrome-headless-shell, not the Debian
# chromium above (kept for the shared libraries it pulls in). Fetched here so
# it's baked into node_modules: otherwise every recreated container's fresh
# node_modules volume downloads it again on the first render.
RUN node -e "require('@remotion/renderer').ensureBrowser().then(() => console.log('chrome-headless-shell ready'))"

# We copy the rest of the files, although we will mount them using volumes in docker-compose
COPY . .

EXPOSE 3000

# Run development server to enable hot-reload
CMD ["npm", "run", "dev"]
