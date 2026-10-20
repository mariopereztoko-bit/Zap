require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const xlsx = require('xlsx');
const fs = require('fs');
const qrcode = require('qrcode');
const { makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });
const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 3 }]);

// Ligação à base de dados Neon
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let sock;
let currentQR = '';      
let isConnected = false; 

// ==========================================
// 1. AUTENTICAÇÃO (LOGIN E REGISTO)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { pin } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM app_users LIMIT 1');
        if (userRes.rows.length === 0) {
            await pool.query('INSERT INTO app_users (username, pin) VALUES ($1, $2)', ['admin', pin]);
            return res.json({ success: true, isNew: true, message: 'Conta criada com sucesso!' });
        } else {
            const user = userRes.rows[0];
            if (user.pin === pin || pin === 'biometrics_passed') {
                return res.json({ success: true, message: 'Login efetuado!' });
            } else {
                return res.status(401).json({ error: 'PIN Incorreto.' });
            }
        }
    } catch (err) {
        console.error("Erro no login:", err);
        res.status(500).json({ error: 'Erro no servidor de autenticação.' });
    }
});

app.get('/api/auth/check', async (req, res) => {
    try {
        const userRes = await pool.query('SELECT COUNT(*) FROM app_users');
        res.json({ hasUsers: parseInt(userRes.rows[0].count) > 0 });
    } catch (err) {
        res.json({ hasUsers: false });
    }
});

// ==========================================
// 2. SESSÃO DO WHATSAPP SEGURA (POSTGRES + CACHE HÍBRIDA)
// ==========================================
async function usePostgresAuthState(pool) {
    // CACHE NA MEMÓRIA: Impede que o Neon limite as conexões e o WhatsApp desconecte
    const localCache = {};

    const writeData = async (data, id) => {
        try {
            localCache[id] = data; // Grava logo na RAM para o Baileys não esperar
            const str = JSON.stringify(data, BufferJSON.replacer);
            // Grava no banco sem pressa e previne duplicações
            await pool.query(`INSERT INTO wa_sessions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, str]);
        } catch (e) {
            console.log(`⚠️ Erro DB Write (${id}):`, e.message);
        }
    };

    const readData = async (id) => {
        try {
            if (localCache[id]) return localCache[id]; // Se estiver na memória, pega na hora!
            const res = await pool.query('SELECT data FROM wa_sessions WHERE id = $1', [id]);
            if (res.rows.length > 0) {
                const parsed = JSON.parse(res.rows[0].data, BufferJSON.reviver);
                localCache[id] = parsed; // Salva na memória para a próxima chamada
                return parsed;
            }
            return null;
        } catch (e) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            delete localCache[id];
            await pool.query('DELETE FROM wa_sessions WHERE id = $1', [id]);
        } catch (e) {}
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    // GRAVAÇÃO SEQUENCIAL: Em vez de bombardear o Neon DB de uma vez, faz um por um.
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                await writeData(value, key);
                            } else {
                                await removeData(key);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await usePostgresAuthState(pool);
        sock = makeWASocket({ 
            auth: state, 
            printQRInTerminal: true, 
            logger: pino({ level: 'silent' }), // Oculta logs excessivos do Baileys
            browser: ["Mac OS", "Chrome", "10.15.7"] // Máscara de navegador para estabilidade
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { currentQR = await qrcode.toDataURL(qr); isConnected = false; }
            
            if (connection === 'close') {
                isConnected = false; currentQR = '';
                const statusCode = lastDisconnect.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log('❌ Conexão fechada. Reconectando?', shouldReconnect, '(Código:', statusCode, ')');
                
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    console.log('🚪 Logout detectado. A limpar sessão do banco de dados...');
                    await pool.query('DELETE FROM wa_sessions').catch(()=>{}); 
                    connectToWhatsApp(); 
                }
            } else if (connection === 'open') {
                isConnected = true; currentQR = ''; 
                console.log('✅ WhatsApp Conectado com Sucesso!');
            }
        });

        // Atualização de status da mensagem (Entregue/Lida)
        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                if (update.update.status) {
                    const statusMap = { 2: 'sent', 3: 'delivered', 4: 'read' };
                    const newStatus = statusMap[update.update.status];
                    if (newStatus && update.key.id) {
                        await pool.query('UPDATE messages SET status = $1, updated_at = NOW() WHERE wa_message_id = $2', [newStatus, update.key.id]).catch(()=>{});
                    }
                }
            }
        });
    } catch (err) {
        console.error("Erro ao iniciar Baileys:", err);
    }
}
connectToWhatsApp();

app.get('/api/status', (req, res) => res.json({ isConnected, qr: currentQR }));

app.post('/api/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        await pool.query('DELETE FROM wa_sessions').catch(()=>{});
        isConnected = false;
        currentQR = '';
        res.json({ success: true, message: 'WhatsApp desconectado com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao desconectar.' });
    }
});

app.post('/api/pair', async (req, res) => {
    try {
        if (isConnected) return res.status(400).json({ error: 'Já está conectado!' });
        let cleanPhone = String(req.body.phone).replace(/\D/g, ''); 
        if (cleanPhone.startsWith('00258')) cleanPhone = cleanPhone.substring(2);
        if (cleanPhone.length === 9 && cleanPhone.startsWith('8')) cleanPhone = '258' + cleanPhone;
        const code = await sock.requestPairingCode(cleanPhone);
        res.json({ success: true, code: code?.match(/.{1,4}/g)?.join('-') || code });
    } catch (error) { res.status(500).json({ error: 'Erro ao gerar o código.' }); }
});

// ==========================================
// 3. LEITURA DE FICHEIROS E VALIDAÇÃO DE NÚMEROS
// ==========================================
function extractNumbers(text, file) {
    let numbers = new Set();
    const processNumber = (n) => {
        let clean = String(n).replace(/\D/g, ''); 
        if (clean.startsWith('00258')) clean = clean.substring(2);
        if (clean.length === 9 && clean.startsWith('8')) numbers.add('258' + clean);
        else if (clean.startsWith('258') && clean.length === 12) numbers.add(clean);
        else if (clean.length > 8) numbers.add(clean); 
    };

    if (text) text.split(/[\n,;]+/).forEach(processNumber);
    if (file) {
        try {
            if (file.originalname.endsWith('.txt') || file.originalname.endsWith('.csv')) {
                const fileText = fs.readFileSync(file.path, 'utf8');
                fileText.split(/[\n,;]+/).forEach(processNumber);
            } else {
                const workbook = xlsx.readFile(file.path);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
                data.forEach(row => { if (row[0]) processNumber(row[0]); });
            }
            fs.unlinkSync(file.path); 
        } catch (error) { console.error('Erro ao ler ficheiro:', error); }
    }
    return Array.from(numbers);
}

app.post('/api/preview', upload.single('file'), (req, res) => {
    const numbers = extractNumbers(req.body.manualNumbers, req.file);
    res.json({ numbers });
});

// ==========================================
// 4. ENVIO DE MENSAGENS EM MASSA (LOOP SEGURO EM SEGUNDO PLANO)
// ==========================================
app.post('/api/send', uploadFields, async (req, res) => {
    try {
        if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado!' });

        const { message, manualNumbers, delay } = req.body;
        const delayMs = delay ? parseInt(delay) * 1000 : 3000;
        
        const contactsFile = req.files['file'] ? req.files['file'][0] : null;
        const imageFiles = req.files['image'] || []; 

        const numbers = extractNumbers(manualNumbers, contactsFile);
        if (numbers.length === 0 || !message) return res.status(400).json({ error: 'Mensagem inválida ou nenhum número detetado.' });

        let imagesBuffer = [];
        for (const file of imageFiles) {
            imagesBuffer.push(fs.readFileSync(file.path));
            fs.unlinkSync(file.path);
        }

        const campRes = await pool.query('INSERT INTO campaigns (message) VALUES ($1) RETURNING id', [message]);
        const campaignId = campRes.rows[0].id;

        // Responde ao utilizador imediatamente (para evitar Timeouts no Front-end ou Render)
        res.json({ success: true, message: `${numbers.length} mensagens enviadas para processamento na fila!`, campaignId });

        // INÍCIO DO LOOP DE DISPARO (Roda solto em Background)
        setTimeout(async () => {
            console.log(`▶ Iniciando disparo para ${numbers.length} contactos... (Delay: ${delayMs/1000}s)`);
            
            for (const number of numbers) {
                const jid = `${number}@s.whatsapp.net`;
                try {
                    // Try/Catch exclusivo para verificação se o número tem WhatsApp
                    let exists = null;
                    try {
                        const existsArray = await sock.onWhatsApp(jid);
                        exists = existsArray && existsArray.length > 0 ? existsArray[0] : null;
                    } catch (e) {
                        console.log(`Aviso ao verificar ${number}: Verificação bloqueada pelo Baileys. A forçar envio...`);
                        exists = { exists: true }; // Se bloquear a pesquisa, força o envio.
                    }

                    if (exists && exists.exists) {
                        let sentMsgId;

                        // Se existirem imagens
                        if (imagesBuffer.length > 0) {
                            for (let i = 0; i < imagesBuffer.length; i++) {
                                const msgOptions = { 
                                    image: Buffer.from(imagesBuffer[i]), 
                                    caption: i === 0 ? message : '' 
                                };
                                const m = await sock.sendMessage(jid, msgOptions);
                                if (i === 0) sentMsgId = m?.key?.id; 
                                if (i < imagesBuffer.length - 1) await new Promise(r => setTimeout(r, 1000));
                            }
                        } else {
                            // Se for apenas texto
                            const m = await sock.sendMessage(jid, { text: message });
                            sentMsgId = m?.key?.id;
                        }

                        // Salva o ID da mensagem com ".catch" para evitar que o Neon trave o sistema se houver erro SQL
                        await pool.query('INSERT INTO messages (campaign_id, phone, status, wa_message_id) VALUES ($1, $2, $3, $4)', [campaignId, number, 'sent', sentMsgId]).catch(err => console.error("Falha DB Sent:", err.message));
                        console.log(`✅ Entregue na fila: ${number}`);
                        
                    } else {
                        await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed (Sem WhatsApp)']).catch(err => console.error("Falha DB Sem WA:", err.message));
                        console.log(`🚫 Número inválido ou sem WA: ${number}`);
                    }
                } catch (error) {
                    // Se o disparo daquela mensagem falhar de forma catastrófica, o loop marca como failed e CONTINUA a próxima.
                    console.error(`❌ Erro crítico ao processar o número ${number}:`, error.message);
                    await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed']).catch(err => console.error("Falha DB Error:", err.message));
                }
                
                // Pausa rigorosa (Delay definido pelo utilizador na interface)
                await new Promise(r => setTimeout(r, delayMs));
            }
            console.log("⏹ Fim do processamento da campanha!");
        }, 0);

    } catch (err) {
        console.error("Erro no processamento da chamada API /send:", err);
        if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor interno.' });
    }
});

// Histórico de campanhas
app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.id, c.message, c.created_at, COUNT(m.id) as total, COUNT(m.id) FILTER (WHERE m.status = 'delivered' OR m.status = 'read') as delivered FROM campaigns c LEFT JOIN messages m ON c.id = m.campaign_id GROUP BY c.id ORDER BY c.created_at DESC`);
        res.json(result.rows);
    } catch (e) {
        console.error("Erro ao buscar histórico:", e.message);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend rodando com sucesso na porta ${PORT}`));