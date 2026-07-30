FROM node:20-bullseye as node-builder

FROM python:3.10-slim-bullseye

# Node.js ve npm kopyala
COPY --from=node-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=node-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/bin/node /usr/local/bin/nodejs && \
    ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app

# Node.js whatsapp-service paketlerini yükle
COPY whatsapp-service/package*.json ./whatsapp-service/
RUN cd whatsapp-service && npm install --production

# Python paketlerini yükle
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Proje dosyalarını kopyala
COPY . .

EXPOSE 8000

CMD ["python", "public/server.py"]
