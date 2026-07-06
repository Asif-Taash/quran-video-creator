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
RUN npm install

# We copy the rest of the files, although we will mount them using volumes in docker-compose
COPY . .

EXPOSE 3000

# Run development server to enable hot-reload
CMD ["npm", "run", "dev"]
