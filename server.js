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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicialización de Clientes
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const preferenceClient = new Preference(mpClient);
const paymentClient = new Payment(mpClient);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Set en memoria para control de idempotencia del Webhook
const processedPayments = new Set();

// --- FUNCIONES DE UTILIDAD ---

// Validar firma criptográfica oficial de Telegram Web App (con fallback para pruebas en navegador)
function verifyTelegramWebAppData(telegramInitData) {
  if (!telegramInitData || telegramInitData.trim() === '') {
    // Si estás probando localmente en la PC fuera de Telegram
    if (process.env.NODE_ENV !== 'production') {
      return { id: 123456789, first_name: 'DevUser', username: 'devuser' };
    }
    return null;
  }
  
  try {
    const urlParams = new URLSearchParams(telegramInitData);
    const hash = urlParams.get('hash');
    if (!hash) return null;

    urlParams.delete('hash');

    const params = [];
    for (const [key, value] of urlParams.entries()) {
      params.push(`${key}=${value}`);
    }
    params.sort();

    const dataCheckString = params.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();
      
    const calculatedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calculatedHash === hash) {
      const userJson = urlParams.get('user');
      return userJson ? JSON.parse(userJson) : null;
    }
    return null;
  } catch (err) {
    console.error('Error verificando WebAppData:', err);
    return null;
  }
}

// Verificar suscripción activa (CORREGIDO: usando .maybeSingle())
async function checkActiveSubscription(telegramId) {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (!user) return false;

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle(); // CORRECCIÓN CLAVE: evita error cuando no hay registros

    if (!sub) return false;
    return new Date(sub.current_period_end) > new Date();
  } catch (err) {
    console.error('Error al verificar suscripción:', err);
    return false;
  }
}

// --- RUTAS API ---

app.post('/api/user-status', async (req, res) => {
  try {
    const { telegramInitData } = req.body;
    const tgUser = verifyTelegramWebAppData(telegramInitData);

    if (!tgUser) {
      return res.status(401).json({ error: 'Autenticación de Telegram inválida' });
    }

    await supabase.from('users').upsert({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name || 'Usuario',
      last_name: tgUser.last_name || '',
      username: tgUser.username || ''
    }, { onConflict: 'telegram_id' });

    const isSubscribed = await checkActiveSubscription(tgUser.id);
    res.json({ user: tgUser, isSubscribed });
  } catch (err) {
    console.error('Error en /api/user-status:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/crear-preferencia', async (req, res) => {
  try {
    const { telegramInitData } = req.body;
    const tgUser = verifyTelegramWebAppData(telegramInitData);

    if (!tgUser) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const preference = await preferenceClient.create({
      body: {
        items: [
          {
            id: 'valeria_sub_mensual',
            title: 'Suscripción Mensual - Valeria Virtual',
            quantity: 1,
            unit_price: 39900,
            currency_id: 'COP'
          }
        ],
        external_reference: tgUser.id.toString(),
        back_urls: {
          success: `${process.env.FRONTEND_URL || 'https://t.me'}?payment=success`,
          failure: `${process.env.FRONTEND_URL || 'https://t.me'}?payment=failure`,
          pending: `${process.env.FRONTEND_URL || 'https://t.me'}?payment=pending`
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

// WEBHOOK OPTIMIZADO
app.post('/api/webhook/mercadopago', async (req, res) => {
  res.sendStatus(200);

  const { type, data } = req.body;

  if (type === 'payment' && data?.id) {
    const paymentId = data.id;

    if (processedPayments.has(paymentId)) return;
    processedPayments.add(paymentId);

    setTimeout(() => processedPayments.delete(paymentId), 3600000);

    setImmediate(async () => {
      try {
        const paymentInfo = await paymentClient.get({ id: paymentId });
        
        if (paymentInfo.status === 'approved') {
          const telegramId = parseInt(paymentInfo.external_reference);

          if (telegramId) {
            const { data: userData } = await supabase
              .from('users')
              .select('id')
              .eq('telegram_id', telegramId)
              .maybeSingle();

            if (userData) {
              const expirationDate = new Date();
              expirationDate.setDate(expirationDate.getDate() + 30);

              await supabase.from('subscriptions').upsert({
                user_id: userData.id,
                payment_id: `mp_${paymentInfo.id}`,
                status: 'active',
                current_period_end: expirationDate.toISOString()
              }, { onConflict: 'user_id' });

              io.to(`user_${telegramId}`).emit('status_suscripcion', { active: true });
            }
          }
        }
      } catch (error) {
        console.error(`Error procesando pago asíncrono ${paymentId}:`, error);
      }
    });
  }
});

// --- COMUNICACIÓN SOCKET.IO ---

io.on('connection', (socket) => {

  socket.on('autenticar', async ({ telegramInitData }) => {
    const tgUser = verifyTelegramWebAppData(telegramInitData);

    if (!tgUser) {
      return socket.emit('error_auth', 'Autenticación fallida');
    }

    socket.telegramId = tgUser.id;
    socket.join(`user_${tgUser.id}`);

    // Asegurar que el usuario existe en BD
    await supabase.from('users').upsert({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name || 'Usuario',
      last_name: tgUser.last_name || '',
      username: tgUser.username || ''
    }, { onConflict: 'telegram_id' });

    // Cargar historial inicial
    const { data: messages } = await supabase
      .from('chat_messages')
      .select('role, content, created_at')
      .eq('telegram_id', tgUser.id)
      .order('created_at', { ascending: true })
      .limit(30);

    socket.emit('cargar_historial', messages || []);
  });

  socket.on('mensaje_usuario', async ({ texto }) => {
    const telegramId = socket.telegramId;
    if (!telegramId) {
      return socket.emit('error_auth', 'Sesión no autenticada');
    }

    const isSubscribed = await checkActiveSubscription(telegramId);
    if (!isSubscribed) {
      return socket.emit('status_suscripcion', { active: false });
    }

    try {
      // 1. Guardar mensaje de usuario
      await supabase.from('chat_messages').insert({
        telegram_id: telegramId,
        role: 'user',
        content: texto
      });

      socket.emit('typing', true);

      // 2. Obtener historial reciente
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

      const formattedHistory = (history || []).map(m => ({
        role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
        content: m.content
      }));

      // 3. Generar respuesta con OpenAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [systemPrompt, ...formattedHistory],
        max_tokens: 250
      });

      const respuestaBot = completion.choices[0].message.content;

      // 4. Guardar respuesta del asistente
      await supabase.from('chat_messages').insert({
        telegram_id: telegramId,
        role: 'assistant',
        content: respuestaBot
      });

      socket.emit('typing', false);
      socket.emit('respuesta_bot', { texto: respuestaBot });
    } catch (err) {
      console.error('Error procesando mensaje:', err);
      socket.emit('typing', false);
      socket.emit('error_servidor', 'Ocurrió un error al responder');
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de Valeria ejecutándose en el puerto ${PORT}`);
});
