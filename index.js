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

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let sock;
let currentQR = '';      
let isConnected = false; 

// ==========================================
// 1. SESSÃO DO WHATSAPP COM FILA DE GRAVAÇÃO (RESOLVE DESCONEXÃO NO NEON DB)
// ==========================================
async function usePostgresAuthState(pool) {
    const localCache = {};
    const writeQueue = [];
    let isWriting = false;

    // Fila Indiana para não derrubar o Neon DB
    const processQueue = async () => {
        if (isWriting || writeQueue.length === 0) return;
        isWriting = true;
        const { id, str, resolve } = writeQueue.shift();
        try {
            await pool.query(`INSERT INTO wa_sessions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, str]);
        } catch (e) {
            console.error(`⚠️ Erro DB Write (${id}):`, e.message);
        }
        resolve();
        isWriting = false;
        processQueue(); // Chama o próximo da fila
    };

    const writeData = (data, id) => {
        localCache[id] = data; // Atualiza a RAM imediatamente
        const str = JSON.stringify(data, BufferJSON.replacer);
        return new Promise((resolve) => {
            writeQueue.push({ id, str, resolve });
            processQueue(); // Inicia a fila
        });
    };

    const readData = async (id) => {
        try {
            if (localCache[id]) return localCache[id];
            const res = await pool.query('SELECT data FROM wa_sessions WHERE id = $1', [id]);
            if (res.rows.length > 0) {
                const parsed = JSON.parse(res.rows[0].data, BufferJSON.reviver);
                localCache[id] = parsed;
                return parsed;
            }
            return null;
        } catch (e) { return null; }
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
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) writeData(value, key);
                            else removeData(key);
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
            logger: pino({ level: 'silent' }),
            browser: ["Mac OS", "Chrome", "10.15.7"],
            syncFullHistory: false, // Evita puxar mensagens antigas para não estourar o banco
            markOnlineOnConnect: true
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
                    console.log('🚪 Logout detectado. A limpar sessão do banco...');
                    await pool.query('DELETE FROM wa_sessions').catch(()=>{}); 
                    connectToWhatsApp(); 
                }
            } else if (connection === 'open') {
                isConnected = true; currentQR = ''; 
                console.log('✅ WhatsApp Conectado com Sucesso e Estável!');
            }
        });

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
    } catch (err) { console.error("Erro ao iniciar Baileys:", err); }
}
connectToWhatsApp();

app.get('/api/status', (req, res) => res.json({ isConnected, qr: currentQR }));

app.post('/api/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        await pool.query('DELETE FROM wa_sessions').catch(()=>{});
        isConnected = false; currentQR = '';
        res.json({ success: true, message: 'Desconectado com sucesso.' });
    } catch (err) { res.status(500).json({ error: 'Erro ao desconectar.' }); }
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
// 2. LEITURA DE FICHEIROS E DISPARO
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
        } catch (error) { console.error('Erro ficheiro:', error); }
    }
    return Array.from(numbers);
}

app.post('/api/preview', upload.single('file'), (req, res) => {
    const numbers = extractNumbers(req.body.manualNumbers, req.file);
    res.json({ numbers });
});

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

        res.json({ success: true, message: `${numbers.length} mensagens enviadas para processamento!`, campaignId });

        setTimeout(async () => {
            console.log(`▶ Iniciando disparo...`);
            for (const number of numbers) {
                const jid = `${number}@s.whatsapp.net`;
                try {
                    let exists = null;
                    try {
                        const existsArray = await sock.onWhatsApp(jid);
                        exists = existsArray && existsArray.length > 0 ? existsArray[0] : null;
                    } catch (e) { exists = { exists: true }; }

                    if (exists && exists.exists) {
                        let sentMsgId;
                        if (imagesBuffer.length > 0) {
                            for (let i = 0; i < imagesBuffer.length; i++) {
                                const msgOptions = { image: Buffer.from(imagesBuffer[i]), caption: i === 0 ? message : '' };
                                const m = await sock.sendMessage(jid, msgOptions);
                                if (i === 0) sentMsgId = m?.key?.id; 
                                if (i < imagesBuffer.length - 1) await new Promise(r => setTimeout(r, 1000));
                            }
                        } else {
                            const m = await sock.sendMessage(jid, { text: message });
                            sentMsgId = m?.key?.id;
                        }
                        await pool.query('INSERT INTO messages (campaign_id, phone, status, wa_message_id) VALUES ($1, $2, $3, $4)', [campaignId, number, 'sent', sentMsgId]).catch(()=>{});
                    } else {
                        await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed (Sem WA)']).catch(()=>{});
                    }
                } catch (error) {
                    await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed']).catch(()=>{});
                }
                await new Promise(r => setTimeout(r, delayMs));
            }
        }, 0);

    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.id, c.message, c.created_at, COUNT(m.id) as total, COUNT(m.id) FILTER (WHERE m.status = 'delivered' OR m.status = 'read') as delivered FROM campaigns c LEFT JOIN messages m ON c.id = m.campaign_id GROUP BY c.id ORDER BY c.created_at DESC`);
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));