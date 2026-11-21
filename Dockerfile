FROM node:22-slim
# git es obligatorio: Minato clona los repos de cada instancia en tiempo de ejecución
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
ENV NODE_ENV=production MINATO_DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--max-old-space-size=96", "src/index.js"]
