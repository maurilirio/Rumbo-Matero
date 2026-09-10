// POST /api/reserva  —  Función serverless (Vercel, runtime Node.js)
//
// Recibe la solicitud de reserva, la valida y sanitiza del lado del servidor,
// aplica rate limiting por IP + honeypot, y envía UN mail transaccional al
// dueño del negocio vía Nitrosend (o Resend como alternativa).
//
// No persiste datos: solo se envían por mail.
// Ningún secreto vive en el código: todo se lee de variables de entorno.

const { randomUUID } = require("node:crypto");

// ------------------------------------------------------------------ config
const OWNER_EMAIL    = process.env.OWNER_EMAIL;                 // destino (dueño)
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "nitrosend").toLowerCase();
const FROM_EMAIL     = process.env.FROM_EMAIL || "";           // opcional (remitente)

const NITROSEND_API_KEY = process.env.NITROSEND_API_KEY;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;

// Rate limiting (best-effort, en memoria del proceso).
const RATE_MAX      = 5;                 // máx. solicitudes...
const RATE_WINDOW_MS = 10 * 60 * 1000;   // ...por IP cada 10 minutos.

// Valores permitidos (lista blanca) para los campos de selección.
const SERVICIOS = ["Compra minorista", "Compra mayorista", "Degustación / visita", "Consulta general"];
const HORARIOS  = ["Mañana", "Tarde", "Noche", "Indistinto"];

// ------------------------------------------------------------- rate limiter
// Nota: el estado en memoria no se comparte entre instancias serverless ni
// sobrevive a un cold start. Es un freno "básico" como se pidió; para un
// límite estricto y distribuido conviene Upstash/Vercel KV.
const hits = new Map(); // ip -> number[] (timestamps)

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  // Limpieza oportunista para no crecer sin control.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return arr.length > RATE_MAX;
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// ------------------------------------------------------------- sanitización
// Quita caracteres de control (incluye CR/LF -> evita inyección de cabeceras),
// colapsa espacios y recorta a un largo máximo.
function clean(value, maxLen) {
  if (value == null) return "";
  let s = String(value);
  s = s.replace(/[\x00-\x1F\x7F]/g, " "); // control chars (incl. CR/LF) -> espacio
  s = s.replace(/[ \t]+/g, " ").trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Igual que clean pero preservando saltos de línea (para el mensaje libre).
function cleanMultiline(value, maxLen) {
  if (value == null) return "";
  let s = String(value).replace(/\r\n?/g, "\n");
  s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, " "); // control chars salvo \n (LF)
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Escapa HTML para insertar valores en el cuerpo del mail sin inyección.
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ------------------------------------------------------------- validaciones
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[\d][\d\s().-]{5,19}$/;

function validate(b) {
  const errors = {};
  const nombre   = clean(b.nombre, 80);
  const contacto = clean(b.contacto, 120);
  const servicio = clean(b.servicio, 60);
  const fecha    = clean(b.fecha, 10);
  const horario  = clean(b.horario, 20);
  const mensaje  = cleanMultiline(b.mensaje, 1000);
  const consent  = b.consent === true || b.consent === "true" || b.consent === "on";

  if (nombre.length < 2) errors.nombre = "Ingresá tu nombre.";

  const isEmail = EMAIL_RE.test(contacto);
  const isPhone = PHONE_RE.test(contacto);
  if (!isEmail && !isPhone) errors.contacto = "Ingresá un email o teléfono válido.";

  if (!SERVICIOS.includes(servicio)) errors.servicio = "Elegí un servicio de interés.";
  if (!HORARIOS.includes(horario))   errors.horario  = "Elegí un horario preferido.";

  // Fecha: formato YYYY-MM-DD, válida, no pasada, dentro de ~1 año.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    errors.fecha = "Elegí una fecha válida.";
  } else {
    const d = new Date(fecha + "T00:00:00");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const max = new Date(today); max.setFullYear(max.getFullYear() + 1);
    if (isNaN(d.getTime())) errors.fecha = "Elegí una fecha válida.";
    else if (d < today)      errors.fecha = "La fecha no puede ser pasada.";
    else if (d > max)        errors.fecha = "Elegí una fecha dentro del próximo año.";
  }

  if (!consent) errors.consent = "Necesitamos tu consentimiento para coordinar la reserva.";

  const contactoTipo = isEmail ? "Email" : "Teléfono";
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    data: { nombre, contacto, contactoTipo, servicio, fecha, horario, mensaje },
  };
}

// ------------------------------------------------------------- armado mail
function buildEmail(d) {
  const subject = clean("Nueva solicitud de reserva — " + d.nombre, 120);

  const rows = [
    ["Nombre", d.nombre],
    [d.contactoTipo + " de contacto", d.contacto],
    ["Servicio de interés", d.servicio],
    ["Fecha preferida", d.fecha],
    ["Horario preferido", d.horario],
    ["Mensaje", d.mensaje || "—"],
  ];

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#26311d;max-width:560px">' +
    '<h2 style="color:#47632c;margin:0 0 4px">Nueva solicitud de reserva</h2>' +
    '<p style="color:#5a6350;margin:0 0 18px">Rumbo Matero · formulario del sitio</p>' +
    '<table style="border-collapse:collapse;width:100%">' +
    rows
      .map(function (r) {
        return (
          '<tr>' +
          '<td style="padding:8px 12px;border:1px solid #e2ddce;background:#f4efe3;font-weight:bold;white-space:nowrap;vertical-align:top">' +
          esc(r[0]) +
          '</td>' +
          '<td style="padding:8px 12px;border:1px solid #e2ddce;white-space:pre-wrap">' +
          esc(r[1]) +
          '</td>' +
          '</tr>'
        );
      })
      .join("") +
    '</table>' +
    '</div>';

  const text = rows.map(function (r) { return r[0] + ": " + r[1]; }).join("\n");

  return { subject, html, text };
}

// ------------------------------------------------------------- envío (mail)
async function sendViaNitrosend(mail, idempotencyKey) {
  const res = await fetch("https://api.nitrosend.com/v1/my/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + NITROSEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      Object.assign(
        {
          channel: "email",
          to: OWNER_EMAIL,
          subject: mail.subject,
          html: mail.html,
          body: mail.text,
          // Requerido por Nitrosend para envíos transaccionales live.
          // Único por solicitud; estable si se reintenta la misma request.
          idempotency_key: idempotencyKey,
        },
        FROM_EMAIL ? { from: FROM_EMAIL } : {}
      )
    ),
  });
  if (!res.ok) {
    const detail = await res.text().catch(function () { return ""; });
    throw new Error("Nitrosend " + res.status + ": " + detail.slice(0, 500));
  }
}

async function sendViaResend(mail, idempotencyKey) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json",
      // Resend deduplica reintentos por esta cabecera.
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: FROM_EMAIL || "Rumbo Matero <onboarding@resend.dev>",
      to: [OWNER_EMAIL],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(function () { return ""; });
    throw new Error("Resend " + res.status + ": " + detail.slice(0, 500));
  }
}

async function sendEmail(mail, idempotencyKey) {
  if (EMAIL_PROVIDER === "resend") {
    if (!RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY");
    return sendViaResend(mail, idempotencyKey);
  }
  if (!NITROSEND_API_KEY) throw new Error("Falta NITROSEND_API_KEY");
  return sendViaNitrosend(mail, idempotencyKey);
}

// ------------------------------------------------------------- body parser
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  // Fallback: leer el stream crudo.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (e) { return null; } // null => JSON inválido
}

// ------------------------------------------------------------- handler
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  // Config mínima requerida en el servidor.
  if (!OWNER_EMAIL) {
    console.error("[reserva] Falta OWNER_EMAIL en variables de entorno.");
    return res.status(500).json({ ok: false, error: "server_misconfigured" });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }

  const body = await readBody(req);
  if (body === null) {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  // Honeypot: si el campo oculto viene lleno, es un bot. Respondemos 200
  // (como si todo saliera bien) para no darle pistas, pero no enviamos nada.
  if (clean(body.website, 200)) {
    return res.status(200).json({ ok: true });
  }

  const v = validate(body);
  if (!v.ok) {
    return res.status(400).json({ ok: false, errors: v.errors });
  }

  const mail = buildEmail(v.data);

  // Clave de idempotencia: única por solicitud de reserva, generada una sola
  // vez por request. Si el envío se reintenta dentro de esta invocación, se
  // reusa la misma clave (Nitrosend/Resend deduplican y no mandan el mail 2 veces).
  const idempotencyKey = randomUUID();

  try {
    await sendEmail(mail, idempotencyKey);
  } catch (err) {
    // Log detallado del lado del servidor; al cliente, mensaje genérico.
    console.error("[reserva] Falló el envío:", err && err.message ? err.message : err);
    return res.status(502).json({ ok: false, error: "send_failed" });
  }

  return res.status(200).json({ ok: true });
};
