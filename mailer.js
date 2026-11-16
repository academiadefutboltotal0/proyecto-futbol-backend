const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.warn('⚠️  SMTP no configurado (faltan SMTP_HOST/SMTP_USER/SMTP_PASS) — los correos no se enviarán, solo quedarán registrados en consola.');
}

const FROM = process.env.SMTP_FROM || 'Academia Futbol Total <no-reply@captaciones.cl>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.captaciones.cl';

async function enviarCorreo({ to, subject, html }) {
  if (!transporter) {
    console.log(`[correo NO enviado — SMTP sin configurar] Para: ${to} | Asunto: ${subject}`);
    return { enviado: false };
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
    return { enviado: true };
  } catch (err) {
    console.error('Error al enviar correo:', err.message);
    return { enviado: false, error: err.message };
  }
}

function enviarCorreoActivacionApoderado(email, nombre, token, whatsappLink) {
  const link = `${FRONTEND_URL}/activar-cuenta/${token}`;
  const bloqueWhatsapp = whatsappLink ? `
        <p style="text-align:center; margin:1.5rem 0 0;">
          <a href="${whatsappLink}" style="color:#16a34a; font-weight:bold; text-decoration:none;">📲 Únete al grupo de WhatsApp de apoderados</a>
        </p>
  ` : '';
  return enviarCorreo({
    to: email,
    subject: 'Activa tu cuenta — Academia Futbol Total',
    html: `
      <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
        <h2>¡Hola${nombre ? ', ' + nombre : ''}!</h2>
        <p>Se creó una cuenta de apoderado para ti en el sistema de la academia.</p>
        <p>Para activarla, confirma tu correo y crea tu propia contraseña haciendo clic en el siguiente botón:</p>
        <p style="text-align:center; margin:2rem 0;">
          <a href="${link}" style="background:#16a34a; color:#fff; padding:0.75rem 1.5rem; border-radius:8px; text-decoration:none; font-weight:bold;">Activar mi cuenta</a>
        </p>
        <p>O copia y pega este link en tu navegador:<br><a href="${link}">${link}</a></p>
        ${bloqueWhatsapp}
        <p style="color:#888; font-size:0.85rem; margin-top:1.5rem;">Este link vence en 72 horas. Si no solicitaste esta cuenta, ignora este correo.</p>
      </div>
    `,
  });
}

function enviarCorreoPagoAprobado(email, nombre, alumno, mes, año) {
  return enviarCorreo({
    to: email,
    subject: 'Tu pago fue aprobado — Academia Futbol Total',
    html: `
      <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
        <h2>¡Hola${nombre ? ', ' + nombre : ''}!</h2>
        <p>Tu comprobante de pago${alumno ? ' de <strong>' + alumno + '</strong>' : ''}${mes ? ' correspondiente a ' + mes + (año ? '/' + año : '') : ''} fue <strong style="color:#16a34a;">aprobado</strong>.</p>
        <p>Gracias por mantener el pago al día.</p>
      </div>
    `,
  });
}

function enviarCorreoPagoRechazado(email, nombre, alumno) {
  return enviarCorreo({
    to: email,
    subject: 'Tu comprobante de pago fue rechazado — Academia Futbol Total',
    html: `
      <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
        <h2>Hola${nombre ? ', ' + nombre : ''}</h2>
        <p>Tu comprobante de pago${alumno ? ' de <strong>' + alumno + '</strong>' : ''} fue <strong style="color:#dc2626;">rechazado</strong>.</p>
        <p>Por favor revisa que el voucher corresponda al monto y la fecha correctas, y vuelve a subirlo desde tu cuenta.</p>
      </div>
    `,
  });
}

function enviarCorreoRecordatorioPago(email, nombre, alumno, mes, año) {
  return enviarCorreo({
    to: email,
    subject: 'Recordatorio de pago pendiente — Academia Futbol Total',
    html: `
      <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
        <h2>Hola${nombre ? ', ' + nombre : ''}</h2>
        <p>Te recordamos que el pago de${alumno ? ' <strong>' + alumno + '</strong> de' : ''} ${mes ? mes + (año ? '/' + año : '') : 'este mes'} sigue pendiente.</p>
        <p>Puedes subir tu comprobante desde tu cuenta de apoderado en la página de la academia.</p>
      </div>
    `,
  });
}

module.exports = {
  enviarCorreo,
  enviarCorreoActivacionApoderado,
  enviarCorreoPagoAprobado,
  enviarCorreoPagoRechazado,
  enviarCorreoRecordatorioPago,
};
