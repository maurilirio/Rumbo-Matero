# Rumbo Matero — Landing + solicitud de reserva

Sitio estático (landing) + un endpoint serverless que recibe solicitudes de
reserva/turno y las envía por mail al dueño del negocio. Pensado para desplegar
en **Vercel**.

```
rumbo-matero-reservas/
├── public/
│   └── index.html        ← la landing (formulario incluido en la sección "Reservá")
├── api/
│   └── reserva.js        ← función serverless: valida, filtra y envía el mail
├── vercel.json           ← headers de seguridad + config de la función
├── .env.example          ← nombres de las variables de entorno (sin valores)
├── package.json
└── .gitignore
```

No hay dependencias npm: la función usa `fetch` nativo de Node 18+.

---

## Cómo funciona

1. El formulario (`public/index.html`, sección **Reservá**) hace `POST /api/reserva`
   con JSON. Ante una respuesta OK muestra la pantalla de confirmación
   *"Recibimos tu solicitud, te contactamos a la brevedad"*.
2. `api/reserva.js` (100% server-side):
   - Acepta solo `POST`.
   - **Rate limiting por IP** (5 solicitudes cada 10 min).
   - **Honeypot**: si el campo oculto `website` viene lleno, responde 200 y
     descarta la solicitud sin enviar nada (no le da pistas al bot).
   - **Valida** todos los campos (requeridos, formato, longitud, fecha no pasada,
     servicio/horario dentro de una lista blanca, consentimiento obligatorio).
   - **Sanitiza** las entradas (quita caracteres de control → evita inyección de
     cabeceras; escapa HTML en el cuerpo del mail).
   - **Envía un único mail** transaccional al `OWNER_EMAIL` vía Nitrosend
     (o Resend). **No guarda datos en ninguna base.**
3. Si el envío falla, el usuario ve un mensaje genérico; el detalle queda solo
   en los logs del servidor (Vercel → Logs).

Ningún secreto vive en el código ni en el cliente: todo se lee de variables de
entorno.

---

## Desplegar en Vercel

1. Subí esta carpeta a un repo (GitHub/GitLab) o usá la CLI de Vercel.
2. En Vercel: **New Project** → importá el repo. No hace falta build command;
   Vercel sirve `public/` como estático y `api/` como funciones.
3. Cargá las **variables de entorno** (Settings → Environment Variables), según
   `.env.example`:

   | Variable | Requerida | Valor |
   |---|---|---|
   | `OWNER_EMAIL` | sí | mail donde querés recibir las solicitudes |
   | `EMAIL_PROVIDER` | no | `nitrosend` (default) o `resend` |
   | `NITROSEND_API_KEY` | sí (si Nitrosend) | `nskey_live_...` desde Nitrosend → Settings → API Keys |
   | `FROM_EMAIL` | no | remitente; vacío = sender verificado de tu marca |
   | `RESEND_API_KEY` | sí (si Resend) | API key de Resend |

4. **Deploy**. Probá el formulario en la URL de Vercel.

### CLI (alternativa)

```bash
npm i -g vercel
vercel            # primer deploy (preview)
vercel env add OWNER_EMAIL
vercel env add NITROSEND_API_KEY
vercel --prod     # deploy a producción
```

---

## Proveedor de mail

### Nitrosend (por defecto)
Usa la API transaccional: `POST https://api.nitrosend.com/v1/my/messages`.
La cuenta ya tiene dominio verificado y sender `hello@mauricio.nitrosend.net`,
así que con solo cargar `NITROSEND_API_KEY` y `OWNER_EMAIL` alcanza.
Generá la key en el dashboard de Nitrosend → **Settings → API Keys**.

### Resend (alternativa)
Poné `EMAIL_PROVIDER=resend`, cargá `RESEND_API_KEY` y un `FROM_EMAIL` de un
dominio verificado en Resend.

---

## Notas y límites

- **Rate limiting**: es en memoria del proceso (best-effort, como se pidió). No
  se comparte entre instancias serverless ni sobrevive a un *cold start*. Para un
  límite estricto y distribuido, conectá Vercel KV o Upstash Redis.
- **Peso de la página**: `index.html` (~11 MB) trae las imágenes embebidas en
  base64 (heredado del diseño original). Para mejor performance conviene, más
  adelante, extraerlas a `/public/img` y referenciarlas por `src`.
- **No persiste datos**: cada solicitud solo se envía por mail.

## Desarrollo local

```bash
npm i -g vercel
vercel dev        # levanta la landing + /api/reserva en localhost
```
Necesitás un `.env` local (copiá `.env.example`) para que el envío funcione.
