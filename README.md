# Valeria - Amiga Virtual (Telegram Mini App + Stripe + OpenAI)

Este proyecto contiene el código completo y listo para despliegue de un bot/amiga virtual con interfaz web dentro de Telegram.

## 📁 Estructura del Proyecto

```text
valeria-bot/
├── Dockerfile                  # Para despliegue en Render, Northflank, Railway, Fly.io
├── .dockerignore
├── package.json                # Dependencias Node.js
├── .env.example                # Plantilla de variables de entorno
├── schema.sql                  # Consultas SQL para inicializar Supabase
├── server.js                   # Servidor Express + Socket.io + Stripe Webhook + OpenAI
└── public/
    └── index.html              # Frontend Telegram Mini App con WebSockets
```

## 🚀 Pasos de Configuración

### 1. Configurar Supabase
- Entra a [Supabase](https://supabase.com/) y crea un proyecto gratuito.
- En el Editor SQL, ejecuta las instrucciones del archivo `schema.sql`.

### 2. Configurar Stripe
- Entra a [Stripe Dashboard](https://dashboard.stripe.com/).
- Crea un producto recurrente de suscripción (ej. $9.99/mes) y copia el **Price ID** (`price_...`).
- Obtén tu **Secret Key** (`sk_test_...`).
- Configura el Webhook apuntando a `https://tu-dominio.com/api/webhook/stripe` escuchando los eventos:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

### 3. Configurar Bot de Telegram
- Habla con `@BotFather` en Telegram.
- Crea un nuevo bot con `/newbot` y guarda el Token.
- Opcional: Ejecuta `/newapp` en `@BotFather` para asociar tu Web App/Mini App al bot.

### 4. Variables de Entorno (`.env`)
Copia `.env.example` a `.env` y completa tus credenciales:
```bash
cp .env.example .env
```

### 5. Ejecución Local
```bash
npm install
npm run dev
```

### 6. Despliegue con Docker
Sube este repositorio a GitHub y vinculalo a **Render**, **Northflank** o **Railway** seleccionando el entorno Docker.
