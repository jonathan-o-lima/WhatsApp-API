FROM debian:12

# Definir o diretório de trabalho
WORKDIR /opt

# Atualizar pacotes e instalar dependências
RUN apt update && \
    apt install -y \
    git nodejs npm psmisc \
    ca-certificates fonts-liberation libappindicator3-1 libatk-bridge2.0-0 libcups2 \
    libdrm-dev libgbm-dev libgtk-3-0 libnspr4 libnss3 libxss1 \
    lsb-release xdg-utils libasound2 libdrm2 libxcomposite1 libxrandr2 \
    libgbm1

RUN git clone https://github.com/jonathan-o-lima/WhatsApp-API.git && \
    cd WhatsApp-API && \
    npm install

# Definir o comando para rodar o aplicativo
CMD ["node", "/opt/WhatsApp-API/index.js"]
