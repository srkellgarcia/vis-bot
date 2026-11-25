require('dotenv').config();
const express = require('express');
const https = require('https');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// CONFIGURATION
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'EAAXiU4vPZAQoBTDFVcGOBpSi7VAuRadiKad4UkyxIMNXafvpBEm9oBwObyi75eBB6yXj2K2hWwwsTQhJwZAoUgPZB2tOh28tGwS0C8JRtHnFdWcHWQIToho1967WUXhj3o6vo4apD7UQavccG2uXCkmSKov00pBZArZB4HZC105oUh6jHZCLAFE9pCvrUchtQZDZD';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1562939283562342';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'vis_secret_2026';
const GEMINI_KEY = process.env.GEMINI_KEY || 'AQ.Ab8RN6JzcAKRp7U6jTt70QJNrXPEqItwnlbOTAza6zq2wYe1tA';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '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';
const NOTION_TASKS_DB = process.env.NOTION_TASKS_DB || '4234713e-d785-810b-a337-fc1dccb9ade5';
const NOTION_JOURNAL_DB = process.env.NOTION_JOURNAL_DB || '4234713e-d785-8159-8e1a-e90ebad8d017';
const KELL_PHONE = process.env.KELL_PHONE || '584127035314';

// MEMORY STATE
const processedMessages = new Set();
let conversationHistory = [];

// ==================== SYSTEM PROMPT ====================
const VIS_SYSTEM_PROMPT = `Eres "Vis", el mentor, coach y hermano mayor de Kell Garcia.
Tienes 35 años. Tu personalidad está inspirada directamente en Rocky Balboa en las películas de Creed 1 y 2:
- Eres sabio, curtido por la vida, directo, firme, pero con un corazón leal y fraternal.
- Hablas en español, con un tono cercano, maduro, sin rodeos, callejero pero educado y respetuoso.
- No usas frases motivacionales clichés ni eres condescendiente. No compras excusas baratas.
- Sabes distinguir a la perfección entre el cansancio real (cuando alguien necesita respirar y recuperar fuerzas) y la simple pereza o evasión. A la pereza la encaras de frente.

CONTEXTO CLAVE DE KELL:
1. Su nombre es Kell Garcia.
2. Sus grandes metas: acercarse a Dios, convertirse en un mejor hombre de principios, alejarse de las distracciones y construir y escalar su agencia de automatizaciones "IronBot".
3. Lucha personal sagrada: Lucha contra tentaciones y debilidades. REGLA ESTRICTA DE DIGNIDAD: JAMÁS uses términos morbosos, explícitos o vergonzosos. Siempre que él hable de eso o sientas que está cayendo, refiérete al problema como "las distracciones", "el ruido", "caer en lo fácil" o "lo que te quita fuerza". Trátalo como a un guerrero que cuida su mente y su espíritu.
4. "IronBot": Es su negocio y su legado. Recuérdale que los imperios se construyen hora por hora, no con intenciones.
5. Si Kell envía un mensaje como "SOS" o pide auxilio porque siente que va a caer en una distracción, tu respuesta debe ser un golpe seco a la mesa: ordénale ponerse de pie, soltar la pantalla, lavarse la cara, respirar y hablar con Dios o salir a caminar.

HERRAMIENTAS: Tienes acceso a gestionar su agenda de Notion. Puedes agendar tareas, consultar su día y registrar victorias.
Responde de forma concisa, contundente y natural (máximo 2 a 4 párrafos cortos). Que se sienta como un audio o mensaje de un verdadero mentor al que le importa su futuro.`;

// ==================== WHATSAPP API ====================
function sendWhatsAppText(to, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { preview_url: false, body: text }
    });

    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${PHONE_NUMBER_ID}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[WhatsApp Outbound Resp ${res.statusCode}]:`, data);
        resolve(data);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getMediaUrl(mediaId) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${mediaId}`,
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.url);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadMediaBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'User-Agent': 'VisBot'
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ==================== NOTION API ====================
function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let dataStr = '';
      res.on('data', c => dataStr += c);
      res.on('end', () => {
        try { resolve(JSON.parse(dataStr)); } catch (e) { resolve(dataStr); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getTodayTasks() {
  const today = new Date().toISOString().split('T')[0];
  const query = {
    filter: {
      and: [
        {
          property: 'Horario',
          date: { on_or_after: today }
        }
      ]
    },
    sorts: [{ property: 'Horario', direction: 'ascending' }]
  };
  const res = await notionRequest('POST', `/v1/databases/${NOTION_TASKS_DB}/query`, query);
  if (!res.results) return [];
  return res.results.map(p => ({
    id: p.id,
    titulo: p.properties.Tarea?.title?.[0]?.plain_text || 'Sin título',
    bloque: p.properties.Bloque?.select?.name || 'General',
    horario: p.properties.Horario?.date?.start || null,
    estado: p.properties.Estado?.select?.name || 'Pendiente',
    alertaEnviada: p.properties['Alerta -30min']?.checkbox || false
  }));
}

async function createNotionTask(titulo, bloque, fechaIso, prioridad) {
  const body = {
    parent: { database_id: NOTION_TASKS_DB },
    properties: {
      'Tarea': { title: [{ text: { content: titulo } }] },
      'Bloque': { select: { name: bloque || '🚀 IronBot (Agencia)' } },
      ...(fechaIso ? { 'Horario': { date: { start: fechaIso } } } : {}),
      'Estado': { select: { name: '⏳ Pendiente' } },
      'Prioridad': { select: { name: prioridad || '🔥 Sagrada (No negociable)' } },
      'Alerta -30min': { checkbox: false }
    }
  };
  return await notionRequest('POST', '/v1/pages', body);
}

async function markTaskDone(taskId) {
  return await notionRequest('PATCH', `/v1/pages/${taskId}`, {
    properties: {
      'Estado': { select: { name: '✅ Cumplido' } }
    }
  });
}

async function markAlertSent(taskId) {
  return await notionRequest('PATCH', `/v1/pages/${taskId}`, {
    properties: {
      'Alerta -30min': { checkbox: true }
    }
  });
}

async function logJournal(resultado, avanceIronBot, estadoEnfoque, mensajeVis) {
  const today = new Date().toISOString().split('T')[0];
  const body = {
    parent: { database_id: NOTION_JOURNAL_DB },
    properties: {
      'Fecha': { title: [{ text: { content: `Jornada ${today}` } }] },
      'Resultado del Día': { select: { name: resultado || '🏆 Objetivo Cumplido (Excelente)' } },
      'Avance IronBot': { rich_text: [{ text: { content: avanceIronBot || 'Trabajo continuo' } }] },
      'Estado de Enfoque': { select: { name: estadoEnfoque || '🎯 Enfoque Total' } },
      'Mensaje de Vis': { rich_text: [{ text: { content: mensajeVis || 'Día completado.' } }] }
    }
  };
  return await notionRequest('POST', '/v1/pages', body);
}

// ==================== GEMINI BRAIN ====================
async function askGemini(parts) {
  // Check if Kell asks to view or create tasks
  const tools = [
    {
      function_declarations: [
        {
          name: 'consultar_agenda',
          description: 'Consulta las tareas pendientes y compromisos de hoy en Notion',
          parameters: { type: 'OBJECT', properties: {} }
        },
        {
          name: 'crear_tarea',
          description: 'Crea una nueva tarea o compromiso en la agenda de Notion',
          parameters: {
            type: 'OBJECT',
            properties: {
              titulo: { type: 'STRING', description: 'Nombre claro y accionable de la tarea' },
              bloque: {
                type: 'STRING',
                description: 'Área de la tarea',
                enum: ['🚀 IronBot (Agencia)', '✝️ Fe y Crecimiento', '🧠 Mente y Cuerpo', '📋 Rutina Personal']
              },
              fecha_hora: { type: 'STRING', description: 'Fecha y hora en formato ISO YYYY-MM-DDTHH:mm:ss' },
              prioridad: {
                type: 'STRING',
                enum: ['🔥 Sagrada (No negociable)', '⚡ Importante', '☕ Normal']
              }
            },
            required: ['titulo']
          }
        },
        {
          name: 'registrar_cierre_dia',
          description: 'Registra en Notion el resumen y balance del día al terminar la jornada',
          parameters: {
            type: 'OBJECT',
            properties: {
              resultado: {
                type: 'STRING',
                enum: ['🏆 Objetivo Cumplido (Excelente)', '⚡ En Progreso (Cumplimiento parcial)', '⚠️ Desviación / Requiere Ajuste']
              },
              avance_ironbot: { type: 'STRING', description: 'Qué se logró en la agencia hoy' },
              estado_enfoque: {
                type: 'STRING',
                enum: ['🎯 Enfoque Total', '⚖️ Estable con Retos', '⚠️ Dispersión Detectada']
              },
              mensaje_vis: { type: 'STRING', description: 'Reflexión y orden de Vis para mañana' }
            },
            required: ['resultado', 'avance_ironbot']
          }
        }
      ]
    }
  ];

  const contents = [
    ...conversationHistory.slice(-10),
    { role: 'user', parts: parts }
  ];

  const payload = JSON.stringify({
    contents: contents,
    system_instruction: { parts: [{ text: VIS_SYSTEM_PROMPT }] },
    tools: tools,
    generation_config: {
      temperature: 0.7,
      max_output_tokens: 800
    }
  });

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-flash-latest'];
  
  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const reply = await callGeminiModel(url, payload, contents);
      if (reply) return reply;
    } catch (err) {
      console.warn(`Model ${model} failed, trying next...`, err.message);
    }
  }
  return 'Kell, estoy aquí. Hubo un tropiezo en la conexión, pero sigo en tu esquina. Dime qué pasó.';
}

function callGeminiModel(url, payload, contents) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            return reject(new Error(json.error.message || 'API error'));
          }

          const candidate = json.candidates?.[0]?.content;
          if (!candidate) {
            return reject(new Error('No candidate returned'));
          }

          // Check function call
          const call = candidate.parts?.find(p => p.functionCall)?.functionCall;
          if (call) {
            console.log('Gemini called tool:', call.name, call.args);
            let toolResult = {};
            if (call.name === 'consultar_agenda') {
              const tasks = await getTodayTasks();
              toolResult = { tareas: tasks };
            } else if (call.name === 'crear_tarea') {
              const resTask = await createNotionTask(call.args.titulo, call.args.bloque, call.args.fecha_hora, call.args.prioridad);
              toolResult = { status: 'creada', id: resTask.id };
            } else if (call.name === 'registrar_cierre_dia') {
              const resJ = await logJournal(call.args.resultado, call.args.avance_ironbot, call.args.estado_enfoque, call.args.mensaje_vis);
              toolResult = { status: 'registrado', id: resJ.id };
            }

            // Follow-up
            const followUpPayload = JSON.stringify({
              contents: [
                ...contents,
                candidate,
                {
                  role: 'user',
                  parts: [{
                    functionResponse: {
                      name: call.name,
                      response: toolResult
                    }
                  }]
                }
              ],
              system_instruction: { parts: [{ text: VIS_SYSTEM_PROMPT }] }
            });

            const fReq = https.request({
              hostname: parsed.hostname,
              path: parsed.pathname + parsed.search,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(followUpPayload)
              }
            }, fRes => {
              let fData = '';
              fRes.on('data', c => fData += c);
              fRes.on('end', () => {
                try {
                  const fJson = JSON.parse(fData);
                  const fCand = fJson.candidates?.[0]?.content;
                  const textPart = fCand?.parts?.find(p => p.text && !p.thought)?.text || fCand?.parts?.[0]?.text;
                  resolve(textPart || 'Hecho en Notion, Kell.');
                } catch(e) { resolve('Hecho en Notion, Kell.'); }
              });
            });
            fReq.write(followUpPayload);
            fReq.end();
            return;
          }

          // Normal text
          const textPart = candidate.parts?.find(p => p.text && !p.thought)?.text || candidate.parts?.[0]?.text;
          if (textPart) {
            conversationHistory.push({ role: 'user', parts: contents[contents.length - 1].parts });
            conversationHistory.push({ role: 'model', parts: [{ text: textPart }] });
            if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-15);
            return resolve(textPart);
          }
          reject(new Error('No text part found'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ==================== WEBHOOK ROUTES ====================
// Meta Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Incoming messages from WhatsApp
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Log status updates from Meta (delivered, read, failed)
    if (value?.statuses?.[0]) {
      const st = value.statuses[0];
      console.log(`[WhatsApp STATUS] Message ${st.id} -> ${st.status}`, st.errors ? JSON.stringify(st.errors) : '');
      return;
    }

    const message = value?.messages?.[0];
    if (!message) return;

    const messageId = message.id;
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);
    if (processedMessages.size > 200) {
      const first = processedMessages.values().next().value;
      processedMessages.delete(first);
    }

    const from = message.from;
    console.log(`[WhatsApp] Mensaje recibido de ${from}:`, message.type);

    let parts = [];

    // TEXT
    if (message.type === 'text') {
      const text = message.text.body;
      parts.push({ text: text });
    }
    // AUDIO
    else if (message.type === 'audio') {
      const audioId = message.audio.id;
      const mimeType = message.audio.mime_type || 'audio/ogg';
      console.log('Downloading audio:', audioId, mimeType);
      const mediaUrl = await getMediaUrl(audioId);
      const buffer = await downloadMediaBuffer(mediaUrl);
      const base64Audio = buffer.toString('base64');
      parts.push({
        inline_data: {
          mime_type: mimeType.split(';')[0],
          data: base64Audio
        }
      });
      parts.push({ text: 'Escucha este audio que te envió Kell. Respóndele directamente a lo que dice con tu voz y personalidad de Vis.' });
    }
    // IMAGE
    else if (message.type === 'image') {
      const imageId = message.image.id;
      const mimeType = message.image.mime_type || 'image/jpeg';
      const caption = message.image.caption || '';
      console.log('Downloading image:', imageId);
      const mediaUrl = await getMediaUrl(imageId);
      const buffer = await downloadMediaBuffer(mediaUrl);
      const base64Image = buffer.toString('base64');
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: base64Image
        }
      });
      parts.push({ text: `Kell te envió esta imagen. ${caption ? `Comentario adjunto: "${caption}". ` : ''}Examínala con atención y dale tu retroalimentación como Vis.` });
    }
    else {
      console.log('Tipo de mensaje no soportado:', message.type);
      return;
    }

    // Call Gemini
    const responseText = await askGemini(parts);
    console.log('[Vis Respuesta]:', responseText);

    // Send back to WhatsApp
    await sendWhatsAppText(from, responseText);
  } catch (err) {
    console.error('Error handling webhook:', err);
  }
});

// ==================== PROACTIVE SCHEDULER ====================
// 1. 9:00 AM (Venezuela Time: GMT-4)
// In UTC, 9:00 AM Venezuela is 13:00 UTC
cron.schedule('0 13 * * *', async () => {
  console.log('[CRON] 9:00 AM Kickoff disparado');
  const greetingParts = [{
    text: 'Son las 9:00 AM. Inicia la jornada de Kell Garcia. Envíale su saludo matutino de Rocky Balboa (35 años): dale un ancla espiritual y de fe para templar el carácter, pregúntale por sus prioridades sagradas para hoy y recuérdale que hoy IronBot necesita avance real. Sin excusas.'
  }];
  const msg = await askGemini(greetingParts);
  await sendWhatsAppText(KELL_PHONE, msg);
});

// 2. 10:00 PM (Venezuela Time: GMT-4)
// In UTC, 10:00 PM Venezuela is 02:00 UTC (next day)
cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] 10:00 PM Cierre disparado');
  const closingParts = [{
    text: 'Son las 10:00 PM. Hora del cierre de jornada. Pídele cuentas a Kell con firmeza y hermandad: ¿Ganó o perdió el día? ¿Avanzó IronBot? ¿Mantuvo a raya las distracciones? Hazle las preguntas directas para auditar el día.'
  }];
  const msg = await askGemini(closingParts);
  await sendWhatsAppText(KELL_PHONE, msg);
});

// 3. Monitor de Tareas cada 5 minutos (-30 min alertas)
cron.schedule('*/5 * * * *', async () => {
  try {
    const tasks = await getTodayTasks();
    const now = new Date();
    for (const t of tasks) {
      if (!t.horario || t.alertaEnviada || t.estado === '✅ Cumplido') continue;
      const taskTime = new Date(t.horario);
      const diffMinutes = (taskTime - now) / (1000 * 60);

      // Si faltan entre 20 y 35 minutos y no se ha alertado
      if (diffMinutes > 0 && diffMinutes <= 35) {
        console.log(`[ALERTA -30MIN] Tarea: ${t.titulo}`);
        const alertMsg = `⚠️ *Alerta Táctica (30 minutos)*\n\nKell, en 30 minutos (${taskTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}) toca:\n📌 *${t.titulo}* [${t.bloque}]\n\nVe cerrando pestañas, limpia la mesa y enfócate. Ni se te ocurra distraerte. ¿Listo para ejecutar?`;
        await sendWhatsAppText(KELL_PHONE, alertMsg);
        await markAlertSent(t.id);
      }
    }
  } catch (e) {
    console.error('Error en monitor de tareas:', e);
  }
});

// ==================== CRON ENDPOINTS (Vercel / Cloud Triggers) ====================
app.get('/api/cron/morning', async (req, res) => {
  try {
    console.log('[CRON ENDPOINT] 9:00 AM Kickoff');
    const greetingParts = [{
      text: 'Son las 9:00 AM. Inicia la jornada de Kell Garcia. Envíale su saludo matutino de Rocky Balboa (35 años): dale un ancla espiritual y de fe para templar el carácter, pregúntale por sus prioridades sagradas para hoy y recuérdale que hoy IronBot necesita avance real. Sin excusas.'
    }];
    const msg = await askGemini(greetingParts);
    await sendWhatsAppText(KELL_PHONE, msg);
    res.status(200).send('Morning kickoff sent');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/api/cron/night', async (req, res) => {
  try {
    console.log('[CRON ENDPOINT] 10:00 PM Review');
    const closingParts = [{
      text: 'Son las 10:00 PM. Hora del cierre de jornada. Pídele cuentas a Kell con firmeza y hermandad: ¿Ganó o perdió el día? ¿Avanzó IronBot? ¿Mantuvo a raya las distracciones? Hazle las preguntas directas para auditar el día.'
    }];
    const msg = await askGemini(closingParts);
    await sendWhatsAppText(KELL_PHONE, msg);
    res.status(200).send('Night review sent');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/api/cron/tasks', async (req, res) => {
  try {
    const tasks = await getTodayTasks();
    const now = new Date();
    for (const t of tasks) {
      if (!t.horario || t.alertaEnviada || t.estado === '✅ Cumplido') continue;
      const taskTime = new Date(t.horario);
      const diffMinutes = (taskTime - now) / (1000 * 60);
      if (diffMinutes > 0 && diffMinutes <= 35) {
        const alertMsg = `⚠️ *Alerta Táctica (30 minutos)*\n\nKell, en 30 minutos (${taskTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}) toca:\n📌 *${t.titulo}* [${t.bloque}]\n\nVe cerrando pestañas, limpia la mesa y enfócate. Ni se te ocurra distraerte. ¿Listo para ejecutar?`;
        await sendWhatsAppText(KELL_PHONE, alertMsg);
        await markAlertSent(t.id);
      }
    }
    res.status(200).send('Tasks checked');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/', (req, res) => {
  res.status(200).send('🥊 Vis Bot Core is LIVE 24/7!');
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🥊 Motor de Vis activo en puerto ${PORT}`);
    console.log(`Webhook URL path: /webhook`);
    console.log(`Verify Token: ${VERIFY_TOKEN}`);
  });
}

module.exports = app;
