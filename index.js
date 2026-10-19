require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const xlsx = require('xlsx');
const fs = require('fs');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let sock;

// Inicializa o Baileys (WhatsApp)
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Mostrará o QR Code nos Logs do Render
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Conectado com Sucesso!');
        }
    });

    // Atualização de status da mensagem
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

// Função que trata números focada no padrão Moçambique
function extractNumbers(text, file) {
    let numbers = new Set();
    
    const processNumber = (n) => {
        let clean = String(n).replace(/\D/g, ''); // Remove tudo que não é número
        
        // Se a pessoa digitou apenas os 9 dígitos (ex: 841234567) adiciona o 258
        if (clean.length === 9 && clean.startsWith('8')) {
            numbers.add('258' + clean);
        } 
        // Se a pessoa já colocou o 258 (tamanho 12 dígitos) adiciona direto
        else if (clean.startsWith('258') && clean.length === 12) {
            numbers.add(clean);
        }
        // Se for número de fora de MZ (ex: Brasil, Portugal), passa como está se tiver mais de 8 dígitos
        else if (clean.length > 8) {
            numbers.add(clean);
        }
    };

    if (text) {
        text.split(/[\n,;]+/).forEach(processNumber);
    }
    
    if (file) {
        try {
            const workbook = xlsx.readFile(file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
            data.forEach(row => {
                if (row[0]) processNumber(row[0]);
            });
            fs.unlinkSync(file.path); // Apaga arquivo temporário
        } catch (error) {
            console.error('Erro ao ler arquivo', error);
        }
    }
    
    return Array.from(numbers);
}

// Rota de Envio em Massa
app.post('/api/send', upload.single('file'), async (req, res) => {
    try {
        const { message, manualNumbers } = req.body;
        const numbers = extractNumbers(manualNumbers, req.file);

        if (numbers.length === 0 || !message) {
            return res.status(400).json({ error: 'Mensagem inválida ou nenhum número válido detectado.' });
        }

        const campRes = await pool.query('INSERT INTO campaigns (message) VALUES ($1) RETURNING id', [message]);
        const campaignId = campRes.rows[0].id;

        res.json({ success: true, message: `${numbers.length} mensagens enviadas para a fila!`, campaignId });

        // Envio com Delay Assíncrono
        for (const number of numbers) {
            const jid = `${number}@s.whatsapp.net`;
            try {
                const [exists] = await sock.onWhatsApp(jid);
                if (exists) {
                    const sentMsg = await sock.sendMessage(jid, { text: message });
                    await pool.query(
                        'INSERT INTO messages (campaign_id, phone, status, wa_message_id) VALUES ($1, $2, $3, $4)',
                        [campaignId, number, 'sent', sentMsg.key.id]
                    );
                } else {
                    await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed (não tem WA)']);
                }
            } catch (error) {
                await pool.query('INSERT INTO messages (campaign_id, phone, status) VALUES ($1, $2, $3)', [campaignId, number, 'failed']);
            }
            // Delay de 3 a 6 segundos para segurança anti-ban
            await new Promise(r => setTimeout(r, Math.random() * 3000 + 3000));
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// Rota de Histórico
app.get('/api/history', async (req, res) => {
    const result = await pool.query(`
        SELECT c.id, c.message, c.created_at,
        COUNT(m.id) as total,
        COUNT(m.id) FILTER (WHERE m.status = 'delivered' OR m.status = 'read') as delivered
        FROM campaigns c
        LEFT JOIN messages m ON c.id = m.campaign_id
        GROUP BY c.id ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));