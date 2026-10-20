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
// 2. SESSÃO DO WHATSAPP SEGURA (POSTGRES)
// ==========================================
async function usePostgresAuthState(pool) {
    const writeData = async (data, id) => {
        try {
            const str = JSON.stringify(data, BufferJSON.replacer);
            // Requer que "id" seja PRIMARY KEY na tabela
            await pool.query(`INSERT INTO wa_sessions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, str]);
        } catch (e) {
            console.log(`⚠️ Erro ao salvar sessão (${id}):`, e.message);
        }
    };
    const readData = async (id) => {
        try {
            const res = await pool.query('SELECT data FROM wa_sessions WHERE id = $1', [id]);
            if (res.rows.length > 0) return JSON.parse(res.rows[0].data, BufferJSON.reviver);
            return null;
        } catch (e) {
            return null;
        }
    };
    const removeData = async (id) => {
        try {
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
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.allSettled(tasks); // Impede que 1 erro quebre tudo
                },
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
            browser: ["Mac OS", "Chrome", "10.15.7"] // Ajuda na estabilidade
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { currentQR = await qrcode.toDataURL(qr); isConnected = false; }
            if (connection === 'close') {
                isConnected = false; currentQR = '';
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                console.log('❌ Conexão fechada. Reconectando:', shouldReconnect);
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    await pool.query('DELETE FROM wa_sessions').catch(()=>{}); 
                    connectToWhatsApp(); 
                }
            } else if (connection === 'open') {
                isConnected = true; currentQR = ''; 
                console.log('✅ WhatsApp Conectado com Sucesso!');
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
    } catch (err) {
        console.error("Erro ao iniciar Baileys:", err);
    }
}
connectToWhatsApp();

app.get('/api/status', (req, res) => res.json({ isConnected, qr: currentQR }));

app.post('/api/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        await pool.query('DELETE FROM wa_sessions');
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
// 3. LEITURA DE FICHEIROS
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
// 4. ENVIO DE MENSAGENS E LOOP CORRIGIDO
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

        // Responde ao cliente imediatamente (para o Render não dar Timeout)
        res.json({ success: true, message: `${numbers.length} mensagens enviadas para processamento em background!`, campaignId });

        // LOOP DE ENVIO EM BACKGROUND ISOLADO
        setTimeout(async () => {
            console.log(`▶ Iniciando disparo para ${numbers.length} contactos...`);
            
            for (const number of numbers) {
                const jid = `${number}@s.whatsapp.net`;
                try {
                    // Try/Catch exclusivo para verificação do número
                    let exists = null;
                    try {
                        const existsArray = await sock.onWhatsApp(jid);
                        exists = existsArray && existsArray.length > 0 ? existsArray[0] : null;
                    } catch (e) {
                        console.log(`Aviso ao checar ${number}: O Baileys bloqueou a verificação, ignorando...`);
                        exists = { exists: true }; // Assume que existe se o Baileys bloquear a query
                    }

                    if (exists && exists.exists) {
                        let sentMsgId;

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
                            const m = await sock.sendMessage(jid, { text: message });
                            sentMsgId = m?.key?.id;
                        }

                        // Try/Catch apenas para o Banco de Dados
                        await pool.query('INSERT INTO messages (campaign_id, phone, status, wa_message_id) VALUES ($1, $2, $3, $4)', [campaignId, number, 'sent', sentMsgId]).catch(err => console.error("Falha DB 1:", err.message));
                        console.log(`✅ Enviado para: ${number}`);
                        
                    } else {
                        await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed (Sem WhatsApp)']).catch(err => console.error("Falha DB 2:", err.message));
                        console.log(`🚫 Não tem WhatsApp: ${number}`);
                    }
                } catch (error) {
                    console.error(`❌ Erro crítico ao enviar para ${number}:`, error.message);
                    await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed']).catch(err => console.error("Falha DB 3:", err.message));
                }
                
                // Pausa rigorosa (Delay)
                await new Promise(r => setTimeout(r, delayMs));
            }
            console.log("⏹ Fim da campanha.");
        }, 0);

    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.id, c.message, c.created_at, COUNT(m.id) as total, COUNT(m.id) FILTER (WHERE m.status = 'delivered' OR m.status = 'read') as delivered FROM campaigns c LEFT JOIN messages m ON c.id = m.campaign_id GROUP BY c.id ORDER BY c.created_at DESC`);
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));