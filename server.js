require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const OpenAI = require('openai');

// 1. Inicialización de clientes
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mapeo en memoria de sockets activos por usuario de Telegram
const activeSockets = new Map();

// System prompt para la personalidad de Valeria
const VALERIA_SYSTEM_PROMPT = `Eres Valeria, una amiga virtual cercana, empatica, bromista y cariñosa. Hablas en español de forma natural, fluida y casual. Respuestas concisas para chat de mensajeria.`;

// ------------------------------------------------------------------
// UTILS: Validación de initData de Telegram WebApp
// ------------------------------------------------------------------
function verifyTelegramInitData(initData) {
  if (!initData) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const params = Array.from(urlParams.entries())
    .map(([key, val]) => `${key}=${val}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(params).digest('hex');

  if (calculatedHash === hash) {
    const userStr = urlParams.get('user');
    return userStr ? JSON.parse(userStr) : null;
  }
  return null;
}

// ------------------------------------------------------------------
// HELPER: Generar Respuesta IA + Historial Supabase
// ------------------------------------------------------------------
async function processChatMessage(telegramId, userText) {
  // 1. Guardar mensaje del usuario en BD
  await supabase.from('messages').insert({ telegram_id: telegramId, role: 'user', content: userText });

  // 2. Obtener últimos 10 mensajes del historial
  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('telegram_id', telegramId)
    .order('created_at', { ascending: false })
    .limit(10);

  const contextMessages = history ? history.reverse() : [];

  // 3. Consultar OpenAI
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: VALERIA_SYSTEM_PROMPT },
      ...contextMessages
    ]
  });

  const botReply = completion.choices[0].message.content;

  // 4. Guardar respuesta del bot en BD
  await supabase.from('messages').insert({ telegram_id: telegramId, role: 'assistant', content: botReply });

  return botReply;
}

// ------------------------------------------------------------------
// RUTAS ENDPOINTS REST
// ------------------------------------------------------------------

// Validar Estado del Usuario y Suscripción
app.post('/api/user-status', async (req, res) => {
  const { telegramInitData } = req.body;
  const user = verifyTelegramInitData(telegramInitData);

  if (!user) {
    return res.status(401).json({ error: 'Autenticacion invalida' });
  }

  // Buscar o crear usuario en Supabase
  let { data: dbUser } = await supabase.from('users').select('*').eq('telegram_id', user.id).single();

  if (!dbUser) {
    const { data: newUser } = await supabase.from('users').insert({
      telegram_id: user.id,
      first_name: user.first_name,
      username: user.username,
      is_subscribed: false
    }).select().single();
    dbUser = newUser;
  }

  return res.json({
    user: dbUser,
    isSubscribed: !!dbUser?.is_subscribed
  });
});

// Crear Preferencia de Mercado Pago
app.post('/api/crear-preferencia', async (req, res) => {
  const { telegramInitData } = req.body;
  const user = verifyTelegramInitData(telegramInitData);

  if (!user) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            id: 'valeria_sub_mensual',
            title: 'Suscripción Mensual - Valeria Virtual',
            quantity: 1,
            unit_price: 15.00,
            currency_id: 'USD'
          }
        ],
        external_reference: String(user.id),
        back_urls: {
          success: `https://t.me/${process.env.BOT_USERNAME}`,
          failure: `https://t.me/${process.env.BOT_USERNAME}`
        },
        auto_return: 'approved'
      }
    });

    res.json({ init_point: result.init_point });
  } catch (error) {
    console.error('Error al crear pago MP:', error);
    res.status(500).json({ error: 'Error interno de pasarela' });
  }
});

// Webhook para Webhooks de Mercado Pago
app.post('/api/webhook-mp', async (req, res) => {
  const { type, data } = req.body;

  if (type === 'payment' && data?.id) {
    // Verificar estado del pago desde API de MP si se requiere o activar usuario
    const paymentId = data.id;
    // ... Lógica de consulta a MP ...
    // Asumiendo activación por external_reference (telegram_id):
    const telegramId = Number(req.body.external_reference);

    if (telegramId) {
      await supabase.from('users').update({ is_subscribed: true }).eq('telegram_id', telegramId);
      
      const socketId = activeSockets.get(telegramId);
      if (socketId) {
        io.to(socketId).emit('status_suscripcion', { active: true });
      }

      await bot.telegram.sendMessage(telegramId, '🎉 ¡Tu suscripción se ha activado correctamente! Ya puedes platicar con Valeria.');
    }
  }

  res.sendStatus(200);
});

// ------------------------------------------------------------------
// MANEJO DE SOCKET.IO
// ------------------------------------------------------------------
io.on('connection', (socket) => {
  const initData = socket.handshake.auth?.telegramInitData;
  const user = verifyTelegramInitData(initData);

  if (user) {
    socket.telegramUserId = user.id;
    activeSockets.set(user.id, socket.id);

    // Cargar historial inicial al conectar
    supabase.from('messages')
      .select('role, content')
      .eq('telegram_id', user.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (data) socket.emit('cargar_historial', data);
      });
  }

  socket.on('autenticar', ({ telegramInitData }) => {
    const authUser = verifyTelegramInitData(telegramInitData);
    if (authUser) {
      socket.telegramUserId = authUser.id;
      activeSockets.set(authUser.id, socket.id);
    }
  });

  socket.on('mensaje_usuario', async (data) => {
    const telegramId = socket.telegramUserId;
    if (!telegramId) return socket.emit('error_auth', 'Sesion expirada');

    // Verificar suscripción activa
    const { data: dbUser } = await supabase.from('users').select('is_subscribed').eq('telegram_id', telegramId).single();
    if (!dbUser?.is_subscribed) {
      return socket.emit('status_suscripcion', { active: false });
    }

    // 1. Reflejar en Telegram el mensaje escrito en la Web App
    await bot.telegram.sendMessage(telegramId, `💬 *Tú (WebApp):* ${data.texto}`, { parse_mode: 'Markdown' });

    // 2. Notificar indicador de escritura
    socket.emit('typing', true);

    // 3. Procesar IA
    const respuestaIA = await processChatMessage(telegramId, data.texto);

    socket.emit('typing', false);

    // 4. Enviar respuesta a WebApp y a Chat de Telegram
    socket.emit('respuesta_bot', { texto: respuestaIA });
    await bot.telegram.sendMessage(telegramId, respuestaIA);
  });

  socket.on('disconnect', () => {
    if (socket.telegramUserId) {
      activeSockets.delete(socket.telegramUserId);
    }
  });
});

// ------------------------------------------------------------------
// BOT TELEGRAM: Mensajes directos desde el cliente Telegram
// ------------------------------------------------------------------
bot.start((ctx) => {
  ctx.reply('¡Hola! Soy Valeria. Abre la Web App o escríbeme directamente por aquí para platicar.', {
    reply_markup: {
      inline_keyboard: [[
        { text: '💬 Abrir Web App', web_app: { url: process.env.WEBAPP_URL } }
      ]]
    }
  });
});

bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const textoUsuario = ctx.message.text;

  // Verificar suscripción
  const { data: dbUser } = await supabase.from('users').select('is_subscribed').eq('telegram_id', telegramId).single();
  if (!dbUser?.is_subscribed) {
    return ctx.reply('🔒 Para platicar con Valeria necesitas activar tu membresia.', {
      reply_markup: {
        inline_keyboard: [[
          { text: '💳 Activar Suscripción', web_app: { url: process.env.WEBAPP_URL } }
        ]]
      }
    });
  }

  // Sincronizar en la WebApp si el usuario la tiene abierta al mismo tiempo
  const socketId = activeSockets.get(telegramId);
  if (socketId) {
    io.to(socketId).emit('cargar_historial', [
      { role: 'user', content: textoUsuario }
    ]);
    io.to(socketId).emit('typing', true);
  }

  // Generar respuesta
  const respuesta = await processChatMessage(telegramId, textoUsuario);

  await ctx.reply(respuesta);

  if (socketId) {
    io.to(socketId).emit('typing', false);
    io.to(socketId).emit('respuesta_bot', { texto: respuesta });
  }
});

// Lanzar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  await bot.launch();
});