require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const OpenAI = require('openai');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Middleware para parsear JSON
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicialización de Clientes
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const preferenceClient = new Preference(mpClient);
const paymentClient = new Payment(mpClient);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- FUNCIONES DE UTILIDAD ---

// Validar firma criptográfica de Telegram Mini App
function verifyTelegramWebAppData(telegramInitData) {
  if (!telegramInitData) return null;
  const urlParams = new URLSearchParams(telegramInitData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const paramsWithData = [];
  for (const [key, val] of urlParams.entries()) {
    paramsWithData.push(`${key}=${val}`);
  }
  paramsWithData.sort();

  const dataCheckString = paramsWithData.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculatedHash === hash) {
    const userJson = urlParams.get('user');
    return userJson ? JSON.parse(userJson) : null;
  }
  return null;
}

// Verificar si el usuario tiene suscripción activa en Supabase
async function checkActiveSubscription(telegramId) {
  const { data: user } = await supabase.from('users').select('id').eq('telegram_id', telegramId).single();
  if (!user) return false;

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('status, current_period_end')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .single();

  if (!sub) return false;
  return new Date(sub.current_period_end) > new Date();
}

// --- RUTAS API ---

// 1. Obtener estado inicial del usuario
app.post('/api/user-status', async (req, res) => {
  try {
    const { telegramInitData } = req.body;
    const tgUser = verifyTelegramWebAppData(telegramInitData);

    if (!tgUser) {
      return res.status(401).json({ error: 'Autenticación de Telegram inválida' });
    }

    // Guardar o actualizar usuario en Supabase
    await supabase.from('users').upsert({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      last_name: tgUser.last_name,
      username: tgUser.username
    }, { onConflict: 'telegram_id' });

    const isSubscribed = await checkActiveSubscription(tgUser.id);
    res.json({ user: tgUser, isSubscribed });
  } catch (err) {
    console.error('Error en /api/user-status:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// 2. Crear Preferencia de Pago en Mercado Pago
app.post('/api/crear-preferencia', async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId requerido' });

    const preference = await preferenceClient.create({
      body: {
        items: [
          {
            id: 'valeria_sub_mensual',
            title: 'Suscripción Mensual - Valeria Virtual',
            quantity: 1,
            unit_price: 39900, // Precio en COP
            currency_id: 'COP'
          }
        ],
        external_reference: telegramId.toString(),
        back_urls: {
          success: `${process.env.FRONTEND_URL}?payment=success`,
          failure: `${process.env.FRONTEND_URL}?payment=failure`,
          pending: `${process.env.FRONTEND_URL}?payment=pending`
        },
        auto_return: 'approved',
        notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`
      }
    });

    res.json({ init_point: preference.init_point });
  } catch (error) {
    console.error('Error creando preferencia en Mercado Pago:', error);
    res.status(500).json({ error: 'Error al generar preferencia de pago' });
  }
});

// 3. Webhook para recibir notificaciones de Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' && data?.id) {
      const paymentInfo = await paymentClient.get({ id: data.id });
      
      if (paymentInfo.status === 'approved') {
        const telegramId = parseInt(paymentInfo.external_reference);

        if (telegramId) {
          // Obtener usuario
          const { data: userData } = await supabase
            .from('users')
            .select('id')
            .eq('telegram_id', telegramId)
            .single();

          if (userData) {
            // Calcular fecha de vencimiento (30 días a partir de hoy)
            const expirationDate = new Date();
            expirationDate.setDate(expirationDate.getDate() + 30);

            // Actualizar o crear suscripción
            await supabase.from('subscriptions').upsert({
              user_id: userData.id,
              stripe_subscription_id: `mp_${paymentInfo.id}`, // Identificador de pago
              status: 'active',
              current_period_end: expirationDate.toISOString()
            }, { onConflict: 'user_id' });

            // Notificar vía Socket.io al usuario en tiempo real
            io.to(`user_${telegramId}`).emit('status_suscripcion', { active: true });
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error en Webhook Mercado Pago:', error);
    res.sendStatus(500);
  }
});

// --- COMUNICACIÓN POR SOCKET.IO ---

io.on('connection', (socket) => {
  console.log('Cliente conectado por Socket:', socket.id);

  socket.on('autenticar', async ({ telegramId }) => {
    if (telegramId) {
      socket.telegramId = telegramId;
      socket.join(`user_${telegramId}`);

      // Enviar historial reciente de mensajes
      const { data: messages } = await supabase
        .from('chat_messages')
        .select('role, content, created_at')
        .eq('telegram_id', telegramId)
        .order('created_at', { ascending: true })
        .limit(30);

      socket.emit('cargar_historial', messages || []);
    }
  });

  socket.on('mensaje_usuario', async ({ texto }) => {
    const telegramId = socket.telegramId;
    if (!telegramId) return;

    // Verificar si la suscripción está activa
    const isSubscribed = await checkActiveSubscription(telegramId);
    if (!isSubscribed) {
      return socket.emit('status_suscripcion', { active: false });
    }

    // 1. Guardar mensaje del usuario en Supabase
    await supabase.from('chat_messages').insert({
      telegram_id: telegramId,
      role: 'user',
      content: texto
    });

    // 2. Consultar contexto del historial para OpenAI
    const { data: history } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('telegram_id', telegramId)
      .order('created_at', { ascending: true })
      .limit(10);

    const systemPrompt = {
      role: 'system',
      content: 'Eres Valeria, una amiga virtual empática, cariñosa, inteligente y alegre. Hablas de forma natural y cercana en español latino. Usa emojis de forma sutil.'
    };

    try {
      socket.emit('typing', true);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [systemPrompt, ...(history || [])],
        max_tokens: 250
      });

      const respuestaBot = completion.choices[0].message.content;

      // 3. Guardar respuesta del bot en Supabase
      await supabase.from('chat_messages').insert({
        telegram_id: telegramId,
        role: 'assistant',
        content: respuestaBot
      });

      socket.emit('typing', false);
      socket.emit('respuesta_bot', { texto: respuestaBot });
    } catch (err) {
      console.error('Error generando respuesta de OpenAI:', err);
      socket.emit('typing', false);
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de Valeria ejecutándose en el puerto ${PORT}`);
});