const express = require('express');
const fileUpload = require('express-fileupload');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const ipRangeCheck = require('ip-range-check');

const app = express();
const port = 3001;

const allowedIPs = [
    '192.168.0.0/16',
    '127.0.0.1',
    '::1',
    '38.224.195.0/24',
];

app.use((req, res, next) => {
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const cleanedIP = clientIP.replace('::ffff:', '');
    if (ipRangeCheck(cleanedIP, allowedIPs)) {
        next();
    } else {
        res.status(403).send('Acesso negado.');
    }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(fileUpload());

// Carregar respostas de responses.json
let responses = { inicio: [], resposta_fim: [] };
try {
    responses = JSON.parse(fs.readFileSync('responses.json'));
    console.log('Respostas carregadas de responses.json:', responses);
} catch (err) {
    console.error('Erro ao carregar responses.json:', err);
    responses = {
        inicio: [
            "Obrigado por entrar em contato. Como posso ajudar você hoje?",
            "Opa, o que precisa?",
            "Como posso ajudar?",
            "O que precisa hoje?"
        ],
        resposta_fim: [
            "Obrigado pela mensagem! Estou analisando e respondo em breve.",
            "Beleza, vou analisar aqui!",
            "Um momento por favor."
        ]
    };
}

// Função para selecionar uma resposta aleatória
function getRandomResponse(array) {
    if (!array || array.length === 0) return "Desculpe, não tenho uma resposta disponível.";
    return array[Math.floor(Math.random() * array.length)];
}

let qrCodeData = null;
let authenticated = false;

const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', function connection(ws, req) {
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const cleanedIP = clientIP.replace('::ffff:', '');
    if (ipRangeCheck(cleanedIP, allowedIPs)) {
        console.log(`Cliente conectado via WebSocket: ${cleanedIP}`);
        if (qrCodeData) {
            ws.send(JSON.stringify({ type: 'qr', data: qrCodeData }));
        }
    } else {
        console.log(`Conexão WebSocket negada para o IP: ${cleanedIP}`);
        ws.terminate();
    }
});

let client;

function createClient() {
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './session' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: null,
            timeout: 0,
        },
    });
    registerClientEvents();
}

function registerClientEvents() {
    client.removeAllListeners();
    client.on('qr', (qr) => {
        qrCodeData = qr;
        console.log('QR Code gerado.');
        wss.clients.forEach(function each(wsClient) {
            if (wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'qr', data: qr }));
            }
        });
    });

    client.on('authenticated', () => {
        console.log('Cliente autenticado com sucesso.');
    });

    client.on('ready', async () => {
        console.log('WhatsApp está pronto!');
        qrCodeData = null;
        await new Promise(resolve => setTimeout(resolve, 5000));
        const info = await client.getState();
        console.log('Estado do cliente:', info);
        authenticated = true;
        loadContactHistory();
        wss.clients.forEach(function each(wsClient) {
            if (wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'authenticated' }));
            }
        });
    });

    client.on('disconnected', (reason) => {
        console.log('Motivo da desconexão:', reason);
        authenticated = false;
        qrCodeData = null;
        wss.clients.forEach(function each(wsClient) {
            if (wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'disconnected' }));
            }
        });
    });

    client.on('auth_failure', (msg) => {
        console.error('Falha na autenticação:', msg);
    });

    client.on('change_state', (state) => {
        console.log('Estado de conexão mudou para:', state);
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`Carregando (${percent}%): ${message}`);
    });

    // Mapa para rastrear contatos: { "sender@chatId": { lastContact: Date } }
    const contactHistory = new Map();
    // Mapa para rastrear fluxo de tickets: { "sender@chatId": { state: string, timestamp: Date, subject?: string } }
    const ticketPrompts = new Map();

    // Função para salvar o histórico
    function saveContactHistory() {
        try {
            const data = Array.from(contactHistory.entries()).map(([key, value]) => [key, value.lastContact]);
            fs.writeFileSync('contactHistory.json', JSON.stringify(data));
            console.log('Histórico de contatos salvo em contactHistory.json');
        } catch (err) {
            console.error('Erro ao salvar histórico de contatos:', err);
        }
    }

    // Função para carregar o histórico
    function loadContactHistory() {
        try {
            if (fs.existsSync('contactHistory.json')) {
                const data = JSON.parse(fs.readFileSync('contactHistory.json'));
                data.forEach(([key, lastContact]) => contactHistory.set(key, { lastContact: new Date(lastContact) }));
                console.log('Histórico de contatos carregado de contactHistory.json');
            } else {
                console.log('Nenhum histórico de contatos encontrado.');
            }
        } catch (err) {
            console.error('Erro ao carregar histórico de contatos:', err);
        }
    }

    // Função para obter saudação
    function getGreeting() {
        const hour = new Date().getHours();
        if (hour >= 5 && hour < 12) return 'Bom dia';
        if (hour >= 12 && hour < 18) return 'Boa tarde';
        return 'Boa noite';
    }

    // Função para verificar primeiro contato do dia
    function isFirstContactOfDay(sender, chatId) {
        const key = `${sender}@${chatId}`;
        const today = new Date().toDateString();
        const lastContact = contactHistory.get(key);

        console.log(`Verificando primeiro contato do dia para ${key}. Hoje: ${today}, Último contato: ${lastContact ? new Date(lastContact.lastContact).toDateString() : 'Nenhum'}`);

        if (!lastContact || new Date(lastContact.lastContact).toDateString() !== today) {
            contactHistory.set(key, { lastContact: new Date() });
            saveContactHistory();
            console.log(`Primeiro contato do dia detectado para ${key}`);
            return true;
        }
        console.log(`Não é o primeiro contato do dia para ${key}`);
        return false;
    }

    // Função para gerar atraso aleatório entre 1 e 7 minutos
    function getRandomDelay() {
        const min = 60 * 1000; // 1 minuto
        const max = 7 * 60 * 1000; // 7 minutos
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    // Evento para processar mensagens
    client.on('message', async (msg) => {
        try {
            console.log(`Mensagem recebida: De ${msg.from}, Para ${msg.to}, Autor ${msg.author || 'N/A'}, Corpo: ${msg.body}, Chat: ${JSON.stringify(msg.chat)}`);

            // Ignorar mensagens do próprio bot
            if (msg.fromMe) {
                console.log('Ignorando mensagem do próprio bot.');
                return;
            }

            // Resposta para !ping
            if (msg.type === 'chat' && msg.body.toLowerCase().trim() === '!ping') {
                console.log('Comando !ping detectado, enviando PONG.');
                await client.sendMessage(msg.to, 'PONG');
                console.log(`Resposta PONG enviada para ${msg.to}`);
                return;
            }

            // Determinar se é grupo
            const isGroup = !!msg.author || msg.from.endsWith('@g.us');
            const chatId = isGroup ? msg.from : msg.from; // msg.from para grupos e individuais
            const sender = isGroup ? msg.author : msg.from; // msg.author em grupos, msg.from em individuais
            console.log(`Contexto: ${isGroup ? 'Grupo' : 'Individual'}, Chat ID: ${chatId}, Remetente: ${sender}`);

            // Obter o nome do usuário
            let userName = msg.notifyName;
            if (!userName) {
                try {
                    const contact = await client.getContactById(sender);
                    userName = contact.pushname || contact.name || 'usuário';
                } catch (err) {
                    console.error(`Erro ao obter contato para ${sender}:`, err);
                    userName = 'usuário';
                }
            }
            console.log(`Nome do usuário obtido: ${userName}`);

            // Verificar fluxo de tickets
            const ticketKey = `${sender}@${chatId}`;
            if (ticketPrompts.has(ticketKey)) {
                const prompt = ticketPrompts.get(ticketKey);
                const timeElapsed = new Date() - new Date(prompt.timestamp);
                // Expirar após 5 minutos (300000 ms)
                if (timeElapsed > 300000) {
                    ticketPrompts.delete(ticketKey);
                    console.log(`Prompt de ticket expirado para ${ticketKey}`);
                } else {
                    if (prompt.state === 'waitingForConfirmation' && /sim/i.test(msg.body)) {
                        console.log(`Resposta "sim" detectada para ticket de ${sender} no chat ${chatId}`);
                        const response = `${userName}, qual o assunto do ticket?`;
                        const delay = getRandomDelay();
                        console.log(`Aguardando ${delay / 1000} segundos antes de enviar pergunta sobre assunto para ${sender} no chat ${chatId}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        await client.sendMessage(chatId, response);
                        console.log(`Pergunta sobre assunto enviada para ${sender} no chat ${chatId}`);
                        ticketPrompts.set(ticketKey, { state: 'waitingForSubject', timestamp: new Date() });
                        return;
                    } else if (prompt.state === 'waitingForSubject') {
                        console.log(`Assunto do ticket recebido de ${sender} no chat ${chatId}: ${msg.body}`);
                        const subject = msg.body;
                        const response = `${userName}, pode me dar um breve resumo do que precisa ser feito?`;
                        const delay = getRandomDelay();
                        console.log(`Aguardando ${delay / 1000} segundos antes de enviar pergunta sobre resumo para ${sender} no chat ${chatId}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        await client.sendMessage(chatId, response);
                        console.log(`Pergunta sobre resumo enviada para ${sender} no chat ${chatId}`);
                        ticketPrompts.set(ticketKey, { state: 'waitingForSummary', timestamp: new Date(), subject });
                        return;
                    } else if (prompt.state === 'waitingForSummary') {
                        console.log(`Resumo do ticket recebido de ${sender} no chat ${chatId}: ${msg.body}`);
                        const summary = msg.body;
                        const response = `${userName}, beleza,\n\nAssunto do Ticket:\n${prompt.subject}\n\nResumo do ticket:\n${summary}`;
                        const delay = getRandomDelay();
                        console.log(`Aguardando ${delay / 1000} segundos antes de enviar resposta final de ticket para ${sender} no chat ${chatId}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        await client.sendMessage(chatId, response);
                        console.log(`Resposta final de ticket enviada para ${sender} no chat ${chatId}: ${response}`);
                        ticketPrompts.delete(ticketKey);
                        return;
                    }
                }
            }

            // Verificar se a mensagem contém "ticket"
            if (/ticket/i.test(msg.body)) {
                console.log(`Palavra "ticket" detectada na mensagem de ${sender} no chat ${chatId}`);
                const response = `${userName}, gostaria de abrir um ticket?`;
                const delay = getRandomDelay();
                console.log(`Aguardando ${delay / 1000} segundos antes de enviar pergunta de ticket para ${sender} no chat ${chatId}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                await client.sendMessage(chatId, response);
                console.log(`Pergunta de ticket enviada para ${sender} no chat ${chatId}`);
                ticketPrompts.set(ticketKey, { state: 'waitingForConfirmation', timestamp: new Date() });
                return;
            }

            // Verificar menção ao bot para saudações
            const botId = client.info.wid._serialized;
            const isBotMentioned = msg.mentionedIds && msg.mentionedIds.includes(botId);
            console.log(`Bot mencionado: ${isBotMentioned}, IDs mencionados: ${msg.mentionedIds ? msg.mentionedIds.join(', ') : 'Nenhum'}`);

            if (!isBotMentioned) {
                console.log('Bot não foi mencionado na mensagem, ignorando.');
                return;
            }

            // Verificar primeiro contato
            const isFirstContact = isFirstContactOfDay(sender, chatId);
            const delay = getRandomDelay();
            console.log(`Aguardando ${delay / 1000} segundos antes de responder para ${sender} no chat ${chatId}`);

            // Aguardar atraso
            await new Promise(resolve => setTimeout(resolve, delay));

            // Preparar resposta
            let response;
            if (isFirstContact) {
                const greeting = getGreeting();
                const baseResponse = getRandomResponse(responses.inicio);
                response = `${userName}, ${greeting}!\n${baseResponse}`;
                console.log(`Enviando saudação para ${sender} no chat ${chatId}: ${response}`);
            } else {
                response = `${userName}, ${getRandomResponse(responses.resposta_fim)}`;
                console.log(`Enviando resposta genérica para ${sender} no chat ${chatId}: ${response}`);
            }

            const result = await client.sendMessage(chatId, response);
            console.log(`Resposta enviada para ${sender} no chat ${chatId}, Resultado: ${JSON.stringify(result)}`);
        } catch (err) {
            console.error(`Erro ao processar mensagem de ${msg.from} em ${msg.to}:`, err);
        }
    });

    // Limpar histórico diariamente
    setInterval(() => {
        contactHistory.clear();
        saveContactHistory();
        console.log('Histórico de contatos limpo para reiniciar saudações.');
    }, 24 * 60 * 60 * 1000);

    // Limpar prompts de ticket expirados
    setInterval(() => {
        const now = new Date();
        for (const [key, prompt] of ticketPrompts.entries()) {
            if (now - new Date(prompt.timestamp) > 300000) {
                ticketPrompts.delete(key);
                console.log(`Prompt de ticket expirado para ${key}`);
            }
        }
    }, 60 * 1000); // Verificar a cada minuto

    // Evento para chamadas
    client.on('call', async (call) => {
        console.log(`Recebida uma chamada de ${call.from} (Tipo: ${call.isVideo ? 'Vídeo' : 'Voz'})`);
        await call.reject();
        console.log('Chamada rejeitada.');
        const message = '*Mensagem automática!*\n\nEste número não aceita chamadas de voz ou de vídeo.';
        await client.sendMessage(call.from, message);
        console.log(`Mensagem automática enviada para ${call.from}`);
    });
}

createClient();
client.initialize();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/qr', async (req, res) => {
    if (authenticated && client) {
        res.json({ status: 'connected', message: 'Cliente já está conectado' });
    } else {
        if (qrCodeData) {
            try {
                const qrCodeImage = await QRCode.toDataURL(qrCodeData);
                const base64Data = qrCodeImage.replace(/^data:image\/png;base64,/, '');
                const imgBuffer = Buffer.from(base64Data, 'base64');

                res.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': imgBuffer.length
                });
                res.end(imgBuffer);
            } catch (err) {
                console.error('Erro ao gerar QR Code:', err);
                res.status(500).json({ status: 'error', message: 'Erro ao gerar QR Code' });
            }
        } else {
            res.json({ status: 'waiting', message: 'QR Code ainda não foi gerado, por favor tente novamente em alguns segundos' });
        }
    }
});

app.get('/api/disconnect', async (req, res) => {
    try {
        console.log('Iniciando logout...');
        await client.logout();
        console.log('Logout concluído.');
        console.log('Destruindo o cliente...');
        await client.destroy();
        console.log('Cliente destruído.');

        client = null;
        qrCodeData = null;
        authenticated = false;

        const sessionPath = path.join(__dirname, 'session');
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log('Dados de autenticação removidos.');
        }

        console.log('Criando novo cliente...');
        createClient();
        console.log('Inicializando novo cliente...');
        client.initialize();

        res.send('Desconectado com sucesso!');
    } catch (err) {
        console.error('Erro ao desconectar:', err);
        res.status(500).json({ status: 'error', message: 'Erro ao desconectar.', error: err });
    }
});

app.get('/api/status', async (req, res) => {
    if (authenticated && client) {
        const state = await client.getState();
        if (state === 'CONNECTED') {
            res.json({ status: 'connected', number: client.info.wid.user });
        } else {
            res.json({ status: 'connecting' });
        }
    } else {
        res.json({ status: 'disconnected' });
    }
});

const sendMessageWithTimeout = async (chatId, message, file, timeout = 20000) => {
    return new Promise(async (resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('Timeout ao enviar mensagem.'));
        }, timeout);

        try {
            const imageRegex = /\[img\s*=\s*(https?:\/\/[^\s]+)\]/i;
            const pdfRegex = /\[pdf\s*=\s*(https?:\/\/[^\s]+)\]/i;

            let match = message.match(imageRegex);
            if (match) {
                const imageUrl = match[1];
                const media = await MessageMedia.fromUrl(imageUrl);
                await client.sendMessage(chatId, media, { caption: message.replace(imageRegex, '') });
                console.log(`Imagem com a mensagem enviada para ${chatId}`);
            } else {
                match = message.match(pdfRegex);
                if (match) {
                    const pdfUrl = match[1];
                    const media = await MessageMedia.fromUrl(pdfUrl);
                    await client.sendMessage(chatId, media, { caption: message.replace(pdfRegex, '') });
                    console.log(`PDF com a mensagem enviado para ${chatId}`);
                } else {
                    if (file) {
                        const filePath = path.join('/tmp', file.name);
                        await file.mv(filePath);
                        const media = MessageMedia.fromFilePath(filePath);
                        await client.sendMessage(chatId, media, { caption: message });
                        console.log(`Mensagem com anexo enviada para ${chatId}`);
                        fs.unlink(filePath, (err) => {
                            if (err) console.error(`Erro ao remover o arquivo: ${filePath}`, err);
                        });
                    } else {
                        await client.sendMessage(chatId, message);
                        console.log(`Mensagem enviada para ${chatId}`);
                    }
                }
            }

            clearTimeout(timeoutId);
            resolve();
        } catch (err) {
            clearTimeout(timeoutId);
            console.error(`Erro ao enviar mensagem para ${chatId}:`, err);
            reject(err);
        }
    });
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.post('/api/send', async (req, res) => {
    try {
        console.log('Recebendo requisição para enviar mensagem.');
        if (!client || !client.info || !authenticated) {
            console.log('Cliente não está pronto.');
            return res.status(500).json({ status: 'error', message: 'Cliente não está pronto. Por favor, tente novamente mais tarde.' });
        }

        const clientState = await client.getState();
        console.log('Estado atual do cliente:', clientState);
        if (clientState !== 'CONNECTED') {
            console.log('Cliente não está conectado.');
            return res.status(500).json({ status: 'error', message: 'Cliente não está conectado ao WhatsApp. Por favor, aguarde.' });
        }

        const { recipients, message } = req.body;
        const recipientList = recipients.split(',');
        const file = req.files ? req.files.file : null;

        console.log('Destinatários:', recipientList);
        console.log('Mensagem:', message);

        const chats = await client.getChats();

        for (const recipient of recipientList) {
            const recipientTrimmed = recipient.trim();

            if (/^\+?\d+$/.test(recipientTrimmed)) {
                let number = recipientTrimmed.replace(/\D/g, '');
                if (number.startsWith("55") && number.length === 13) {
                    // number = number.slice(0, 4) + number.slice(5);
                }
                const chatId = number + "@c.us";
                await sendMessageWithTimeout(chatId, message, file);
            } else {
                const group = chats.find(chat => chat.isGroup && chat.name === recipientTrimmed);
                if (group) {
                    await sendMessageWithTimeout(group.id._serialized, message, file);
                } else {
                    console.error(`Grupo ${recipientTrimmed} não encontrado.`);
                }
            }

            await delay(5000);
        }

        res.status(200).json({ status: 'success', message: 'Mensagem enviada!' });
    } catch (err) {
        console.error('Erro ao processar o envio:', err);
        res.status(500).json({ status: 'error', message: 'Erro ao processar o envio.', error: err.message });
    }
});

app.get('/api/sendMessage/:recipient/:message', async (req, res) => {
    try {
        console.log('Recebendo requisição para enviar mensagem via GET.');
        if (!client || !client.info || !authenticated) {
            console.log('Cliente não está pronto.');
            return res.status(500).json({ status: 'error', message: 'Cliente não está pronto. Por favor, tente novamente mais tarde.' });
        }

        const clientState = await client.getState();
        console.log('Estado atual do cliente:', clientState);
        if (clientState !== 'CONNECTED') {
            console.log('Cliente não está conectado.');
            return res.status(500).json({ status: 'error', message: 'Cliente não está conectado ao WhatsApp. Por favor, aguarde.' });
        }

        const recipientParam = req.params.recipient;
        const message = decodeURIComponent(req.params.message);
        console.log('Destinatário:', recipientParam);
        console.log('Mensagem:', message);

        function processPhoneNumber(number) {
            number = number.replace(/[\s()+-]/g, '');
            if (number.startsWith('55') && number.length === 13) {
                number = number.slice(0, 4) + number.slice(5);
            }
            return number;
        }

        let chatId;
        if (/^\d+$/.test(recipientParam)) {
            let number = processPhoneNumber(recipientParam);
            chatId = number + "@c.us";
        } else {
            const chats = await client.getChats();
            const group = chats.find(chat => chat.isGroup && chat.name === recipientParam);
            if (group) {
                chatId = group.id._serialized;
            } else {
                console.error(`Grupo "${recipientParam}" não encontrado.`);
                return res.status(404).json({ status: 'error', message: `Grupo "${recipientParam}" não encontrado.` });
            }
        }

        await client.sendMessage(chatId, message);
        console.log(`Mensagem enviada para ${chatId}`);
        res.status(200).json({ status: 'success', message: 'Mensagem enviada!' });
    } catch (err) {
        console.error('Erro ao enviar mensagem via GET:', err);
        res.status(500).json({ status: 'error', message: 'Erro ao enviar mensagem.', error: err.message });
    }
});

app.listen(port, () => {
    console.log(`API rodando na porta ${port}`);
});
