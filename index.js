require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const xlsx = require('xlsx');
const fs = require('fs');
const qrcode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

// Agora aceitamos dois campos de ficheiro: 'file' (contactos) e 'image' (imagem da campanha)
const upload = multer({ dest: 'uploads/' });
const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let sock;
let currentQR = '';      
let isConnected = false; 

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = await qrcode.toDataURL(qr);
            isConnected = false;
        }

        if (connection === 'close') {
            isConnected = false;
            currentQR = '';
            const statusCode = lastDisconnect.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                connectToWhatsApp();
            } else {
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = '';
            console.log('✅ WhatsApp Conectado com Sucesso!');
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.status) {
                const statusMap = { 2: 'sent', 3: 'delivered', 4: 'read' };
                const newStatus = statusMap[update.update.status];
                if (newStatus && update.key.id) {
                    await pool.query('UPDATE messages SET status = $1, updated_at = NOW() WHERE wa_message_id = $2', [newStatus, update.key.id]);
                }
            }
        }
    });
}
connectToWhatsApp();

app.get('/api/status', (req, res) => {
    res.json({ isConnected, qr: currentQR });
});

function extractNumbers(text, file) {
    let numbers = new Set();
    const processNumber = (n) => {
        let clean = String(n).replace(/\D/g, ''); 
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
            fs.unlinkSync(file.path); // Apaga ficheiro excel após extrair
        } catch (error) { console.error(error); }
    }
    return Array.from(numbers);
}

// ROTA DE ENVIO ATUALIZADA (Lida com imagem)
app.post('/api/send', uploadFields, async (req, res) => {
    try {
        if (!isConnected) return res.status(400).json({ error: 'WhatsApp não está conectado!' });

        const { message, manualNumbers } = req.body;
        
        // Pega os ficheiros carregados
        const contactsFile = req.files['file'] ? req.files['file'][0] : null;
        const imageFile = req.files['image'] ? req.files['image'][0] : null;

        const numbers = extractNumbers(manualNumbers, contactsFile);

        if (numbers.length === 0 || !message) {
            return res.status(400).json({ error: 'Mensagem inválida ou nenhum número válido detectado.' });
        }

        // Se o utilizador enviou uma imagem, nós lemos a imagem para a memória
        let imageBuffer = null;
        if (imageFile) {
            imageBuffer = fs.readFileSync(imageFile.path);
            fs.unlinkSync(imageFile.path); // Apaga a imagem do servidor após ler para não encher o disco
        }

        const campRes = await pool.query('INSERT INTO campaigns (message) VALUES ($1) RETURNING id', [message]);
        const campaignId = campRes.rows[0].id;

        res.json({ success: true, message: `${numbers.length} mensagens enviadas para a fila!`, campaignId });

        // Loop de envio
        for (const number of numbers) {
            const jid = `${number}@s.whatsapp.net`;
            try {
                const [exists] = await sock.onWhatsApp(jid);
                if (exists) {
                    
                    // Se tem imagem, manda a imagem e põe o texto como legenda. Se não, manda só texto.
                    const msgOptions = imageBuffer 
                        ? { image: imageBuffer, caption: message } 
                        : { text: message };

                    const sentMsg = await sock.sendMessage(jid, msgOptions);
                    
                    await pool.query('INSERT INTO messages (campaign_id, phone, status, wa_message_id) VALUES ($1, $2, $3, $4)', [campaignId, number, 'sent', sentMsg.key.id]);
                } else {
                    await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed (não tem WA)']);
                }
            } catch (error) {
                await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed']);
            }
            // Delay anti-ban
            await new Promise(r => setTimeout(r, Math.random() * 3000 + 3000));
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.get('/api/history', async (req, res) => {
    const result = await pool.query(`
        SELECT c.id, c.message, c.created_at, COUNT(m.id) as total,
        COUNT(m.id) FILTER (WHERE m.status = 'delivered' OR m.status = 'read') as delivered
        FROM campaigns c LEFT JOIN messages m ON c.id = m.campaign_id
        GROUP BY c.id ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));