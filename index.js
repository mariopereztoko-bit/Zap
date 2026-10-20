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

// ATUALIZAÇÃO: Aceita até 3 imagens de uma vez
const upload = multer({ dest: 'uploads/' });
const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 3 }]);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let sock;
let currentQR = '';      
let isConnected = false; 

// Base de Dados para Sessão 
async function usePostgresAuthState(pool) {
    const writeData = async (data, id) => {
        const str = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(`INSERT INTO wa_sessions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, str]);
    };
    const readData = async (id) => {
        const res = await pool.query('SELECT data FROM wa_sessions WHERE id = $1', [id]);
        if (res.rows.length > 0) return JSON.parse(res.rows[0].data, BufferJSON.reviver);
        return null;
    };
    const removeData = async (id) => {
        await pool.query('DELETE FROM wa_sessions WHERE id = $1', [id]);
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
                    await Promise.all(tasks);
                },
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// Inicializa WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await usePostgresAuthState(pool);
    sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { currentQR = await qrcode.toDataURL(qr); isConnected = false; }
        if (connection === 'close') {
            isConnected = false; currentQR = '';
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
            else { await pool.query('DELETE FROM wa_sessions'); connectToWhatsApp(); }
        } else if (connection === 'open') {
            isConnected = true; currentQR = ''; console.log('✅ WhatsApp Conectado com Sucesso!');
        }
    });
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.status) {
                const statusMap = { 2: 'sent', 3: 'delivered', 4: 'read' };
                const newStatus = statusMap[update.update.status];
                if (newStatus && update.key.id) await pool.query('UPDATE messages SET status = $1, updated_at = NOW() WHERE wa_message_id = $2', [newStatus, update.key.id]);
            }
        }
    });
}
connectToWhatsApp();

app.get('/api/status', (req, res) => res.json({ isConnected, qr: currentQR }));

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

// FUNÇÃO DE EXTRAÇÃO MELHORADA
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
            const workbook = xlsx.readFile(file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
            data.forEach(row => { if (row[0]) processNumber(row[0]); });
            fs.unlinkSync(file.path); 
        } catch (error) { console.error(error); }
    }
    return Array.from(numbers);
}

// NOVO ENDPOINT: Devolve a lista de números extraídos para o Frontend mostrar
app.post('/api/preview', upload.single('file'), (req, res) => {
    const { manualNumbers } = req.body;
    const numbers = extractNumbers(manualNumbers, req.file);
    res.json({ numbers });
});

// ENVIO DE MENSAGENS COM ATÉ 3 IMAGENS
app.post('/api/send', uploadFields, async (req, res) => {
    try {
        if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado!' });

        const { message, manualNumbers } = req.body;
        const contactsFile = req.files['file'] ? req.files['file'][0] : null;
        const imageFiles = req.files['image'] || []; // Agora é um array (até 3)

        const numbers = extractNumbers(manualNumbers, contactsFile);
        if (numbers.length === 0 || !message) return res.status(400).json({ error: 'Mensagem inválida ou nenhum número válido detetado.' });

        // Lê todas as imagens para memória e apaga os ficheiros do servidor
        let imagesBuffer = [];
        for (const file of imageFiles) {
            imagesBuffer.push(fs.readFileSync(file.path));
            fs.unlinkSync(file.path);
        }

        const campRes = await pool.query('INSERT INTO campaigns (message) VALUES ($1) RETURNING id', [message]);
        const campaignId = campRes.rows[0].id;

        res.json({ success: true, message: `${numbers.length} mensagens com ${imagesBuffer.length} imagens enviadas para a fila!`, campaignId });

        for (const number of numbers) {
            const jid = `${number}@s.whatsapp.net`;
            try {
                const [exists] = await sock.onWhatsApp(jid);
                if (exists) {
                    let sentMsgId;

                    if (imagesBuffer.length > 0) {
                        // Envia as imagens uma a uma (Até 3)
                        for (let i = 0; i < imagesBuffer.length; i++) {
                            // A legenda (texto) vai agarrada apenas à primeira imagem
                            const msgOptions = { 
                                image: imagesBuffer[i], 
                                caption: i === 0 ? message : '' 
                            };
                            const m = await sock.sendMessage(jid, msgOptions);
                            
                            if (i === 0) sentMsgId = m.key.id; // Guarda o ID da 1ª mensagem para histórico
                            
                            // Atraso de 1,5 segundos entre as 3 imagens do mesmo utilizador
                            if (i < imagesBuffer.length - 1) await new Promise(r => setTimeout(r, 1500));
                        }
                    } else {
                        // Se não tem imagens, envia só texto
                        const m = await sock.sendMessage(jid, { text: message });
                        sentMsgId = m.key.id;
                    }

                    await pool.query('INSERT INTO messages (campaign_id, phone, status, wa_message_id) VALUES ($1, $2, $3, $4)', [campaignId, number, 'sent', sentMsgId]);
                } else {
                    await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed (não tem WA)']);
                }
            } catch (error) {
                await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed']);
            }
            // Delay Anti-ban entre um contacto e outro
            await new Promise(r => setTimeout(r, Math.random() * 3000 + 3000));
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.get('/api/history', async (req, res) => {
    const result = await pool.query(`SELECT c.id, c.message, c.created_at, COUNT(m.id) as total, COUNT(m.id) FILTER (WHERE m.status = 'delivered' OR m.status = 'read') as delivered FROM campaigns c LEFT JOIN messages m ON c.id = m.campaign_id GROUP BY c.id ORDER BY c.created_at DESC`);
    res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));