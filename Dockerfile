FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/tmp
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-noto-cjk \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-writer \
    nodejs \
    npm \
    pandoc \
    poppler-utils \
    unzip \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY . .
RUN chmod -R a+x node_modules/.bin || true
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV LLM_WIKI_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
VOLUME ["/data"]
CMD ["npm", "start"]
