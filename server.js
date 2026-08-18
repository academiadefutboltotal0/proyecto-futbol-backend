require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Pago = require('./models/Pago');
const Noticia = require('./models/Noticia');
const SiteConfig = require('./models/SiteConfig');
const Estudiante = require('./models/Estudiante');
const Profesor = require('./models/Profesor');
const Division = require('./models/Division');
const Partido = require('./models/Partido');
const UsuarioSistema = require('./models/UsuarioSistema');
const bcrypt = require('bcrypt');
const Asistencia = require('./models/Asistencia');
const Rendimiento = require('./models/Rendimiento');
const { enviarCorreoActivacionApoderado } = require('./mailer');

if (!process.env.MONGODB_URI) {
  console.error('❌ Falta MONGODB_URI en las variables de entorno');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error('❌ Falta JWT_SECRET en las variables de entorno');
  process.exit(1);
}

if (!process.env.ADMIN_USER || !(process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD_HASH)) {
  console.error('❌ Falta ADMIN_USER o ADMIN_PASSWORD/ADMIN_PASSWORD_HASH en las variables de entorno');
  process.exit(1);
}

async function getConfig() {
  let config = await SiteConfig.findOne();
  if (!config) config = await SiteConfig.create({});
  return config;
}

const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : true;
if (corsOrigin === true) {
  console.warn('⚠️  CORS_ORIGIN no está configurado — aceptando peticiones de cualquier origen. Define CORS_ORIGIN en producción (ej. https://tu-frontend.vercel.app).');
}
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '20mb' }));

/* Elimina claves con $ o . del body para prevenir NoSQL injection (compatible con Express 5) */
function sanitizarBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) { delete obj[key]; continue; }
    if (typeof obj[key] === 'object') sanitizarBody(obj[key]);
  }
  return obj;
}
app.use((req, _res, next) => { if (req.body) sanitizarBody(req.body); next(); });

/* Health-check público — responde sin tocar la BD, evita cold start */
app.get('/ping', (_req, res) => res.json({ ok: true }));

/* Rate limiting en endpoints públicos de registro */
const limiteRegistro = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { mensaje: 'Demasiados intentos. Espera 15 minutos antes de volver a intentarlo.' }
});

/* Rate limiting en el login para evitar fuerza bruta */
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { mensaje: 'Demasiados intentos de inicio de sesión. Espera 15 minutos antes de volver a intentarlo.' }
});

/* Valida longitud de campos de texto para evitar saturación */
function validarLongitudes(campos) {
  const limites = { nombre: 80, apellidos: 80, apellidoPaterno: 80, apellidoMaterno: 80,
    correo: 100, telefono: 20, rut: 15, cedula: 15, direccion: 150, notas: 500 };
  function revisar(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && limites[k] && v.length > limites[k])
        return `El campo "${k}" supera el máximo permitido (${limites[k]} caracteres)`;
      if (typeof v === 'object') { const r = revisar(v); if (r) return r; }
    }
    return null;
  }
  return revisar(campos);
}

function calcularDigitoVerificadorRut(cuerpo) {
  let suma = 0;
  let multiplicador = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += parseInt(cuerpo[i], 10) * multiplicador;
    multiplicador = multiplicador === 7 ? 2 : multiplicador + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

/* Valida un RUT chileno (dígito verificador incluido) y devuelve su forma normalizada
   "12345678-9", o null si el formato o el dígito verificador son inválidos. */
function validarYNormalizarRut(valor) {
  const limpio = (valor || '').toString().replace(/[^0-9kK]/g, '').toUpperCase();
  if (limpio.length < 2) return null;
  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1);
  if (!/^\d{7,8}$/.test(cuerpo)) return null;
  if (calcularDigitoVerificadorRut(cuerpo) !== dv) return null;
  return `${cuerpo}-${dv}`;
}

/* Valida un número de celular/WhatsApp chileno y devuelve su forma normalizada
   "+56 9 XXXX XXXX", o null si no calza con el formato esperado. */
function validarYNormalizarWhatsapp(valor) {
  if (!valor) return null;
  let digitos = valor.toString().replace(/[^0-9]/g, '');
  if (digitos.startsWith('56') && digitos.length === 11) digitos = digitos.slice(2);
  if (digitos.length === 10 && digitos.startsWith('0')) digitos = digitos.slice(1);
  if (digitos.length !== 9 || digitos[0] !== '9') return null;
  return `+56 9 ${digitos.slice(1, 5)} ${digitos.slice(5)}`;
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🟢 Conectado a MongoDB'))
  .catch((err) => console.error('🔴 Error MongoDB:', err));

const InscripcionSchema = new mongoose.Schema({
  apoderado: {
    nombre: String,
    apellidos: String,
    correo: String,
    telefono: String,
  },
  pupilo: {
    nombre: String,
    apellidoPaterno: String,
    apellidoMaterno: String,
    rut: String,
    fechaNacimiento: String,
    genero: Object,
    direccion: String,
    comuna: Object,
  },
  estado: {
    type: String,
    default: 'pendiente',
  },
  fechaRegistro: {
    type: Date,
    default: Date.now,
  },
});

const Inscripcion = mongoose.model('Inscripcion', InscripcionSchema);

const FichaTemporadaSchema = new mongoose.Schema({
  fechaIngreso: {
    type: Date,
    default: Date.now,
  },

  nombre: { type: String, required: true },
  apellidoPaterno: String,
  apellidoMaterno: String,
  apellido: String,
  direccion: String,
  ciudad: String,
  sede: String,
  fechaNacimiento: String,
  cedula: String,

  edad: Number,
  categoria: String,

  establecimiento: String,
  curso: String,
  clubAmateur: String,
  equipoPreferido: String,
  jugadorReferente: String,
  talla: String,

  horarioSalidaColegio: {
    lunes: String,
    martes: String,
    miercoles: String,
    jueves: String,
    viernes: String,
    sabado: String,
    domingo: String,
  },

  numerosFavoritos: [Number],

  nombreCamiseta: String,
  posicion: String,
  pieHabil: String,

  aniosJugando: Number,
  otrosDeportes: String,
  otrasEscuelas: String,

  actitudSocial: String,
  actitudAdversidad: String,

  beca: { type: Boolean, default: false },

  apoderado: {
    nombre: String,
    direccion: String,
    ciudad: String,
    rut: String,
    correo: String,
    telefonoCasa: String,
    whatsapp: String,
    vinculo: String,
  },
});

const FichaTemporada = mongoose.model('FichaTemporada', FichaTemporadaSchema, 'fichatemporadas');

const PagoMensualSchema = new mongoose.Schema({
  fichaId: { type: mongoose.Schema.Types.ObjectId, required: true },
  mes: { type: Number, required: true },
  año: { type: Number, required: true },
  estado: { type: String, enum: ['pendiente', 'pagado'], default: 'pendiente' },
  monto: { type: Number, default: 20000 },
  fechaPago: Date,
  observacion: String
});
const PagoMensual = mongoose.model('PagoMensual', PagoMensualSchema);

const InvitacionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  creadoEn: { type: Date, default: Date.now },
  expiraEn: { type: Date, required: true },
  usado: { type: Boolean, default: false }
});
const Invitacion = mongoose.model('Invitacion', InvitacionSchema);

function calcularEdad(fechaNacimiento) {
  const hoy = new Date();
  const nacimiento = new Date(`${fechaNacimiento}T00:00:00`);

  let edad = hoy.getFullYear() - nacimiento.getFullYear();

  const mes = hoy.getMonth() - nacimiento.getMonth();

  if (mes < 0 || (mes === 0 && hoy.getDate() < nacimiento.getDate())) {
    edad--;
  }

  return edad;
}

function obtenerCategoria(fechaNacimiento) {
  const edad = calcularEdad(fechaNacimiento);

  if (edad <= 6) return 'Sub-6';
  if (edad <= 8) return 'Sub-8';
  if (edad <= 10) return 'Sub-10';
  if (edad <= 12) return 'Sub-12';
  if (edad <= 14) return 'Sub-14';
  if (edad <= 16) return 'Sub-16';
  if (edad <= 18) return 'Sub-18';

  return 'Libre';
}

function obtenerCategoriaDinamica(fechaNacimiento, genero = null) {
  const edad = calcularEdad(fechaNacimiento);
  
  // Prioridad: rama femenina si género indica "Femenino"
  if (genero && typeof genero === 'object' && (genero.name === 'Femenino' || genero.value === 'Femenino')) {
    return 'Femenina';
  }
  if (typeof genero === 'string' && genero.toLowerCase().includes('femenin')) {
    return 'Femenina';
  }
  
  // Asignación por rango de edad
  if (edad >= 5 && edad <= 6) return 'Sub-6';
  if (edad >= 7 && edad <= 8) return 'Sub-8';
  if (edad >= 9 && edad <= 10) return 'Sub-10';
  if (edad >= 11 && edad <= 12) return 'Sub-12';
  if (edad >= 13 && edad <= 14) return 'Sub-14';
  if (edad >= 15 && edad <= 16) return 'Sub-16';
  if (edad >= 17 && edad <= 18) return 'Sub-18';
  
  return 'Fuera de Rango / Adulto';
}
/*Creación automática de usuarios con datos registrados*/
function generarUsuario(nombre, apellido, dominio = 'nombredominio.cl') {
  const primerNombre = nombre.trim().toLowerCase().split(' ')[0];
  const primerasTres = apellido.trim().toLowerCase().slice(0, 3);

  return `${primerNombre}.${primerasTres}@${dominio}`;
}

/* Genera una contraseña temporal aleatoria seguras (no adivinable a partir de datos públicos) */
function generarClaveTemporal() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // sin 0/O/1/l/I para evitar confusión
  let clave = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) {
    clave += alfabeto[bytes[i] % alfabeto.length];
  }
  return clave;
}

/* LOGIN */
app.post('/login', limiteLogin, async (req, res) => {
  try {
    const { user, password } = req.body || {};

    if (!user || !password) {
      return res.status(400).json({
        mensaje: 'Usuario y contraseña son obligatorios'
      });
    }

    const adminValido = process.env.ADMIN_PASSWORD_HASH
      ? (user === process.env.ADMIN_USER && await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH))
      : (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD);

    if (adminValido) {
      const token = jwt.sign(
        {
          user,
          rol: 'admin'
        },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      );

      return res.json({
        token,
        usuario: {
          nombre: 'Administrador',
          email: user,
          rol: 'admin'
        }
      });
    }

    const usuario = await UsuarioSistema.findOne({
      email: { $regex: new RegExp(`^${user.toLowerCase().trim()}$`, 'i') }
    });

    if (!usuario) {
      return res.status(401).json({
        mensaje: 'Usuario o contraseña incorrectos'
      });
    }

    if (usuario.estado !== 'activo') {
      return res.status(403).json({
        mensaje: 'Usuario inactivo'
      });
    }

    const passwordValida = await bcrypt.compare(
      password,
      usuario.passwordHash
    );

    if (!passwordValida) {
      return res.status(401).json({
        mensaje: 'Usuario o contraseña incorrectos'
      });
    }

    const token = jwt.sign(
      {
        id: usuario._id,
        email: usuario.email,
        rol: usuario.rol
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      usuario: {
        id: usuario._id,
        nombre: usuario.nombre,
        email: usuario.email,
        rol: usuario.rol,
        debeCambiarPassword: usuario.debeCambiarPassword
      }
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      mensaje: 'Error al iniciar sesión'
    });
  }
});

/* CAMBIAR CONTRASEÑA (profesor / cliente) */
app.post('/cambiar-password', verificarToken, async (req, res) => {
  try {
    if (req.user.rol === 'admin') {
      return res.status(400).json({ mensaje: 'La cuenta admin no soporta cambio de contraseña desde aquí' });
    }
    const { passwordActual, passwordNueva } = req.body;
    if (!passwordActual || !passwordNueva) {
      return res.status(400).json({ mensaje: 'La contraseña actual y la nueva son obligatorias' });
    }
    if (passwordNueva.length < 8) {
      return res.status(400).json({ mensaje: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    const usuario = await UsuarioSistema.findById(req.user.id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado' });

    const valida = await bcrypt.compare(passwordActual, usuario.passwordHash);
    if (!valida) return res.status(401).json({ mensaje: 'La contraseña actual es incorrecta' });

    usuario.passwordHash = await bcrypt.hash(passwordNueva, 10);
    usuario.debeCambiarPassword = false;
    await usuario.save();

    res.json({ mensaje: 'Contraseña actualizada correctamente' });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al cambiar la contraseña' });
  }
});

/* MIDDLEWARE: verificar token */
function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ mensaje: 'Token requerido' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ mensaje: 'Token inválido o expirado' });
    }
    req.user = decoded;
    next();
  });
}

/* MIDDLEWARE: solo administrador */
function soloAdmin(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ mensaje: 'Acceso solo para administradores' });
  next();
}

/* RUTAS PÚBLICAS */
app.get('/', (req, res) => {
  res.send('Servidor funcionando');
});

app.get('/noticias', async (req, res) => {
  try {
    const noticias = await Noticia.find().sort({ createdAt: -1 });
    res.json(noticias);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener noticias' });
  }
});

app.get('/config', async (req, res) => {
  try {
    const config = await getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener configuración' });
  }
});

/* Partidos (GET público, resto protegido) */
app.get('/partidos', async (req, res) => {
  try {
    const data = await Partido.find().sort({ fecha: 1 });
    res.json(data);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener partidos' });
  }
});
app.post('/partidos', verificarToken, soloAdmin, async (req, res) => {
  try { res.status(201).json(await new Partido(req.body).save()); }
  catch (e) { res.status(500).json({ mensaje: 'Error al crear partido' }); }
});
app.put('/partidos/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const doc = await Partido.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
    if (!doc) return res.status(404).json({ mensaje: 'No encontrado' });
    res.json(doc);
  } catch (e) { res.status(500).json({ mensaje: 'Error al actualizar partido' }); }
});
app.delete('/partidos/:id', verificarToken, soloAdmin, async (req, res) => {
  try { await Partido.findByIdAndDelete(req.params.id); res.json({ mensaje: 'Eliminado' }); }
  catch (e) { res.status(500).json({ mensaje: 'Error al eliminar partido' }); }
});

app.post('/inscripcion', limiteRegistro, async (req, res) => {
  try {
    const error = validarLongitudes(req.body);
    if (error) return res.status(400).json({ mensaje: error });
    const nueva = new Inscripcion(req.body);
    await nueva.save();
    console.log('💾 Guardado en MongoDB');
    res.json({ mensaje: 'Guardado correctamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al guardar' });
  }
});

/* INVITACIONES - link temporal de registro */
app.post('/admin/generar-invitacion', verificarToken, soloAdmin, async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const expiraEn = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await Invitacion.create({ token, expiraEn });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al generar invitación' });
  }
});

app.get('/invitacion/:token', async (req, res) => {
  try {
    const inv = await Invitacion.findOne({ token: req.params.token });
    if (!inv) return res.status(404).json({ mensaje: 'Link inválido' });
    if (inv.usado) return res.status(410).json({ mensaje: 'Este link ya fue utilizado' });
    if (inv.expiraEn < new Date()) return res.status(410).json({ mensaje: 'Este link ha expirado' });
    res.json({ valido: true });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al validar invitación' });
  }
});

app.post('/ficha-temporada', limiteRegistro, async (req, res) => {
  try {
    const { invitacionToken, ...datos } = req.body;
    const errorLong = validarLongitudes(datos);
    if (errorLong) return res.status(400).json({ mensaje: errorLong });

    let invitacion = null;
    if (invitacionToken) {
      invitacion = await Invitacion.findOne({ token: invitacionToken });
      if (!invitacion) return res.status(404).json({ mensaje: 'Link inválido' });
      if (invitacion.usado) return res.status(410).json({ mensaje: 'Este link ya fue utilizado' });
      if (invitacion.expiraEn < new Date()) return res.status(410).json({ mensaje: 'Este link ha expirado' });
      // OJO: no se marca "usado" todavía — recién se marca al final, si la ficha se
      // guarda con éxito. Así, si el RUT es inválido/duplicado, la familia puede
      // corregir el dato y reenviar el mismo formulario sin necesitar un link nuevo.
    }

    // Normalizar payload del registro-invitado (estructura pupilo/apoderado)
    if (datos.pupilo) {
      const p = datos.pupilo;
      const a = datos.apoderado || {};
      datos.nombre = p.nombre || '';
      datos.apellidoPaterno = p.apellidoPaterno || '';
      datos.apellidoMaterno = p.apellidoMaterno || '';
      datos.apellido = [p.apellidoPaterno, p.apellidoMaterno].filter(Boolean).join(' ');
      datos.cedula = p.rut;
      datos.fechaNacimiento = p.fechaNacimiento;
      datos.direccion = p.direccion;
      datos.ciudad = p.comuna?.name ?? p.comuna ?? '';
      datos.sede = p.sede || '';
      datos.apoderado = {
        nombre: [a.nombre, a.apellidos].filter(Boolean).join(' '),
        correo: a.correo,
        telefonoCasa: a.telefono,
        whatsapp: a.telefono,
      };
      delete datos.pupilo;
    }

    datos.edad = calcularEdad(datos.fechaNacimiento);
    datos.categoria = obtenerCategoria(datos.fechaNacimiento);

    if (typeof datos.numerosFavoritos === 'string') {
      datos.numerosFavoritos = datos.numerosFavoritos
        .split(',')
        .map((n) => Number(n.trim()))
        .filter((n) => !isNaN(n));
    }

    const rutNormalizado = validarYNormalizarRut(datos.cedula);
    if (!rutNormalizado) {
      return res.status(400).json({ mensaje: 'El RUT ingresado no es válido. Revísalo (formato esperado: 12345678-9).' });
    }
    datos.cedula = rutNormalizado;

    if (datos.apoderado?.whatsapp) {
      const whatsappNormalizado = validarYNormalizarWhatsapp(datos.apoderado.whatsapp);
      if (!whatsappNormalizado) {
        return res.status(400).json({ mensaje: 'El número de WhatsApp no es válido. Revísalo (formato esperado: +56 9 1234 5678).' });
      }
      datos.apoderado.whatsapp = whatsappNormalizado;
    }

    const existentes = await FichaTemporada.find({ cedula: { $exists: true, $ne: '' } }).select('cedula');
    const yaExiste = existentes.some(f => f.cedula === rutNormalizado);
    if (yaExiste) {
      return res.status(409).json({ mensaje: 'Este jugador ya está registrado (RUT duplicado).' });
    }

    const ficha = new FichaTemporada(datos);
    await ficha.save();

    if (invitacion) {
      invitacion.usado = true;
      await invitacion.save();
    }

    // Crea la cuenta del apoderado y le manda el correo de activación automáticamente.
    // Si ya tiene cuenta (ej. está inscribiendo a un segundo hijo), no hace nada.
    // Un fallo acá no debe hacer fallar el registro de la ficha, que ya se guardó bien.
    if (ficha.apoderado?.correo) {
      try {
        await crearCuentaClienteConActivacion(ficha.apoderado.correo, ficha.apoderado.nombre);
      } catch (errCorreo) {
        console.error('No se pudo crear la cuenta cliente automáticamente:', errCorreo.message);
      }
    }

    res.status(201).json({
      mensaje: 'Ficha guardada correctamente',
      ficha,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      mensaje: 'Error al guardar ficha',
    });
  }
});

app.get('/ficha-temporada', verificarToken, soloAdmin, async (req, res) => {
  try {
    const fichas = await FichaTemporada.find().sort({ categoria: 1, nombre: 1 });
    const clientes = await UsuarioSistema.find({ rol: 'cliente' }).select('email');
    const emailsCliente = new Set(clientes.map(c => c.email));
    const hoy = new Date();
    const mes = hoy.getMonth() + 1;
    const año = hoy.getFullYear();
    const pagos = await PagoMensual.find({ mes, año });
    const pagoMap = {};
    pagos.forEach(p => { pagoMap[p.fichaId.toString()] = p.estado; });
    const fichasConEstado = fichas.map(f => ({
      ...f.toObject(),
      tieneCuenta: f.apoderado?.correo ? emailsCliente.has(f.apoderado.correo) : false,
      pagoMesActual: pagoMap[f._id.toString()] || 'pendiente'
    }));
    res.json(fichasConEstado);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener fichas' });
  }
});

app.put('/ficha-temporada/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const datos = req.body;
    if (datos.fechaNacimiento) {
      datos.edad = calcularEdad(datos.fechaNacimiento);
      datos.categoria = obtenerCategoria(datos.fechaNacimiento);
    }
    if (typeof datos.numerosFavoritos === 'string') {
      datos.numerosFavoritos = datos.numerosFavoritos.split(',').map(n => Number(n.trim())).filter(n => !isNaN(n));
    }
    if (datos.cedula) {
      const rutNormalizado = validarYNormalizarRut(datos.cedula);
      if (!rutNormalizado) {
        return res.status(400).json({ mensaje: 'El RUT ingresado no es válido. Revísalo (formato esperado: 12345678-9).' });
      }
      datos.cedula = rutNormalizado;
    }
    if (datos.apoderado?.whatsapp) {
      const whatsappNormalizado = validarYNormalizarWhatsapp(datos.apoderado.whatsapp);
      if (!whatsappNormalizado) {
        return res.status(400).json({ mensaje: 'El número de WhatsApp no es válido. Revísalo (formato esperado: +56 9 1234 5678).' });
      }
      datos.apoderado.whatsapp = whatsappNormalizado;
    }
    const ficha = await FichaTemporada.findByIdAndUpdate(req.params.id, datos, { returnDocument: 'after', runValidators: false });
    if (!ficha) return res.status(404).json({ mensaje: 'Ficha no encontrada' });
    res.json(ficha);
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: 'Error al actualizar ficha' });
  }
});

app.delete('/ficha-temporada/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const ficha = await FichaTemporada.findById(req.params.id);
    if (!ficha) return res.status(404).json({ mensaje: 'Ficha no encontrada' });
    if (ficha.apoderado?.correo) {
      await UsuarioSistema.deleteOne({ email: ficha.apoderado.correo, rol: 'cliente' });
    }
    await Asistencia.deleteMany({ jugadorId: ficha._id });
    await FichaTemporada.findByIdAndDelete(req.params.id);
    res.json({ mensaje: 'Jugador eliminado correctamente' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: 'Error al eliminar' });
  }
});

app.post('/pagos', verificarToken, limiteRegistro, async (req, res) => {
  try {
    const { apoderado, alumno, sede, monto, fecha, voucherBase64, fichaId } = req.body;

    if (req.user.rol === 'cliente') {
      if (!fichaId) return res.status(400).json({ mensaje: 'fichaId es obligatorio' });
      const ficha = await FichaTemporada.findOne({
        _id: fichaId,
        'apoderado.correo': { $regex: new RegExp(`^${req.user.email}$`, 'i') }
      }).select('_id');
      if (!ficha) return res.status(403).json({ mensaje: 'No tienes acceso a esta ficha' });
    }

    const nuevoPago = new Pago({
      apoderado, alumno, sede, monto, fecha, voucherBase64, fichaId,
      estado: 'pendiente',
    });
    const guardado = await nuevoPago.save();
    res.status(201).json(guardado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al guardar el pago' });
  }
});

/* Calcula el promedio de los valores numéricos de un objeto de sub-ítems */
function promedioCategoria(obj) {
  if (!obj) return 0;
  const vals = Object.entries(obj)
    .filter(([k]) => k !== 'promedio')
    .map(([, v]) => Number(v))
    .filter(v => !isNaN(v));
  if (!vals.length) return 0;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

app.get('/rendimientos/resumen/:jugadorId', verificarToken, soloProfesor, async (req, res) => {
  try {
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    const permitido = usuario?.profesorId && await jugadorPerteneceAProfesor(req.params.jugadorId, usuario.profesorId);
    if (!permitido) return res.status(403).json({ mensaje: 'No tienes acceso a este jugador' });

    const rendimientos = await Rendimiento.find({ jugadorId: req.params.jugadorId });
    if (!rendimientos.length) return res.json({ totalEvaluaciones: 0, promedioGeneral: 0 });

    const avg = (campo) =>
      Math.round(rendimientos.reduce((s, r) => s + (r[campo]?.promedio || 0), 0) / rendimientos.length);

    res.json({
      totalEvaluaciones: rendimientos.length,
      fisico:      avg('fisico'),
      tecnico:     avg('tecnico'),
      actitudinal: avg('actitudinal'),
      estrategico: avg('estrategico'),
      promedioGeneral: Math.round(
        rendimientos.reduce((s, r) => s + (r.promedioGeneral || 0), 0) / rendimientos.length
      )
    });
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al obtener resumen' });
  }
});

app.get('/rendimientos/:jugadorId', verificarToken, soloProfesor, async (req, res) => {
  try {
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    const permitido = usuario?.profesorId && await jugadorPerteneceAProfesor(req.params.jugadorId, usuario.profesorId);
    if (!permitido) return res.status(403).json({ mensaje: 'No tienes acceso a este jugador' });

    const rendimientos = await Rendimiento.find({ jugadorId: req.params.jugadorId })
      .sort({ fecha: -1 });
    res.json(rendimientos);
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al obtener rendimientos' });
  }
});

app.post('/rendimientos', verificarToken, soloProfesor, async (req, res) => {
  try {
    const { jugadorId, fisico, tecnico, actitudinal, estrategico, comentario } = req.body;
    if (!jugadorId) return res.status(400).json({ mensaje: 'jugadorId es obligatorio' });
    if (!mongoose.Types.ObjectId.isValid(jugadorId))
      return res.status(400).json({ mensaje: 'jugadorId inválido' });
    if (!fisico || typeof fisico !== 'object' || Array.isArray(fisico))
      return res.status(400).json({ mensaje: 'fisico debe ser un objeto' });
    if (!tecnico || typeof tecnico !== 'object' || Array.isArray(tecnico))
      return res.status(400).json({ mensaje: 'tecnico debe ser un objeto' });
    if (!actitudinal || typeof actitudinal !== 'object' || Array.isArray(actitudinal))
      return res.status(400).json({ mensaje: 'actitudinal debe ser un objeto' });
    if (!estrategico || typeof estrategico !== 'object' || Array.isArray(estrategico))
      return res.status(400).json({ mensaje: 'estrategico debe ser un objeto' });

    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    const permitido = usuario?.profesorId && await jugadorPerteneceAProfesor(jugadorId, usuario.profesorId);
    if (!permitido) return res.status(403).json({ mensaje: 'No tienes acceso a este jugador' });

    const fProm = promedioCategoria(fisico);
    const tProm = promedioCategoria(tecnico);
    const aProm = promedioCategoria(actitudinal);
    const eProm = promedioCategoria(estrategico);
    const promedioGeneral = Math.round((fProm + tProm + aProm + eProm) / 4);
    const ahora = new Date();

    const doc = {
      jugadorId:   new mongoose.Types.ObjectId(jugadorId),
      profesorId:  usuario.profesorId._id,
      fecha:       ahora,
      fisico:      { ...fisico, promedio: fProm },
      tecnico:     { ...tecnico, promedio: tProm },
      actitudinal: { ...actitudinal, promedio: aProm },
      estrategico: { ...estrategico, promedio: eProm },
      promedioGeneral,
      comentario:  comentario || '',
      createdAt:   ahora,
      updatedAt:   ahora,
    };

    const result = await Rendimiento.collection.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (e) {
    console.error('POST /rendimientos error:', e?.name, e?.message);
    res.status(500).json({
      mensaje: 'Error al registrar rendimiento',
      detalle: e?.message || String(e),
      tipo: e?.name,
    });
  }
});

/* Permite al profesor corregir una evaluación de rendimiento ya guardada (propia o de un
   colega), siempre que el jugador esté dentro de sus divisiones/sede asignadas. */
app.put('/rendimientos/:id', verificarToken, soloProfesor, async (req, res) => {
  try {
    const { fisico, tecnico, actitudinal, estrategico, comentario } = req.body;
    if (!fisico || !tecnico || !actitudinal || !estrategico) {
      return res.status(400).json({ mensaje: 'fisico, tecnico, actitudinal y estrategico son obligatorios' });
    }

    const existente = await Rendimiento.findById(req.params.id);
    if (!existente) return res.status(404).json({ mensaje: 'Rendimiento no encontrado' });

    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    const permitido = usuario?.profesorId && await jugadorPerteneceAProfesor(existente.jugadorId, usuario.profesorId);
    if (!permitido) return res.status(403).json({ mensaje: 'No tienes acceso a este jugador' });

    const fProm = promedioCategoria(fisico);
    const tProm = promedioCategoria(tecnico);
    const aProm = promedioCategoria(actitudinal);
    const eProm = promedioCategoria(estrategico);
    const promedioGeneral = Math.round((fProm + tProm + aProm + eProm) / 4);

    existente.fisico = { ...fisico, promedio: fProm };
    existente.tecnico = { ...tecnico, promedio: tProm };
    existente.actitudinal = { ...actitudinal, promedio: aProm };
    existente.estrategico = { ...estrategico, promedio: eProm };
    existente.promedioGeneral = promedioGeneral;
    existente.comentario = comentario || '';
    await existente.save();

    res.json(existente);
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al editar rendimiento' });
  }
});

app.post('/profesores/crear-acceso', verificarToken, soloAdmin, async (req, res) => {
  try {
    let {
      nombre,
      apellido,
      rut,
      fechaNacimiento,
      especialidad,
      experiencia,
      divisiones,
      sede,
      telefono
    } = req.body;

    nombre = nombre?.trim();
    apellido = apellido?.trim();
    rut = rut?.trim();

    if (!nombre || !apellido || !rut) {
      return res.status(400).json({
        mensaje: 'Nombre, apellido y rut son obligatorios'
      });
    }

    const email = generarUsuario(nombre, apellido);
    const passwordTemporal = generarClaveTemporal();

    const existeUsuario = await UsuarioSistema.findOne({ email });

    if (existeUsuario) {
      return res.status(400).json({
        mensaje: 'Ya existe un usuario con ese correo'
      });
    }

    const existeProfesor = await Profesor.findOne({ rut });

    if (existeProfesor) {
      return res.status(400).json({
        mensaje: 'Ya existe un profesor registrado con ese RUT'
      });
    }
    const profesor = await new Profesor({
      nombre,
      apellido,
      rut,
      fechaNacimiento,
      especialidad,
      experiencia,
      divisiones: Array.isArray(divisiones) ? divisiones : [],
      sede: sede?.trim() || '',
      telefono,
      email,
      estadoSolicitud: 'aceptado',
      estado: 'activo',
      creadoPorAdmin: true
    }).save();

    const passwordHash = await bcrypt.hash(passwordTemporal, 10);

    await new UsuarioSistema({
      nombre: `${nombre} ${apellido}`,
      email,
      passwordHash,
      rol: 'profesor',
      profesorId: profesor._id,
      estado: 'activo',
      debeCambiarPassword: true
    }).save();

    res.status(201).json({
      mensaje: 'Profesor creado correctamente',
      credenciales: {
        email,
        passwordTemporal
      },
      profesor
    });

  } catch (error) {
    console.error('Error creando profesor:', error);

    res.status(500).json({
      mensaje: 'Error al crear profesor'
    });
  }
});

/* RUTAS PROTEGIDAS (requieren token) */

function crudRoutes(app, path, Model, middlewares = []) {
  app.get(path, verificarToken, ...middlewares, async (req, res) => {
    try { res.json(await Model.find().sort({ createdAt: -1 })); }
    catch (e) { res.status(500).json({ mensaje: 'Error al obtener datos' }); }
  });
  app.post(path, verificarToken, ...middlewares, async (req, res) => {
    try { res.status(201).json(await new Model(req.body).save()); }
    catch (e) { res.status(500).json({ mensaje: 'Error al crear' }); }
  });
  app.put(`${path}/:id`, verificarToken, ...middlewares, async (req, res) => {
    try {
      const doc = await Model.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
      if (!doc) return res.status(404).json({ mensaje: 'No encontrado' });
      res.json(doc);
    } catch (e) { res.status(500).json({ mensaje: 'Error al actualizar' }); }
  });
  app.delete(`${path}/:id`, verificarToken, ...middlewares, async (req, res) => {
    try { await Model.findByIdAndDelete(req.params.id); res.json({ mensaje: 'Eliminado' }); }
    catch (e) { res.status(500).json({ mensaje: 'Error al eliminar' }); }
  });
}

crudRoutes(app, '/estudiantes', Estudiante, [soloAdmin]);

/* DIVISIONES */
app.get('/divisiones', verificarToken, soloAdmin, async (req, res) => {
  try {
    res.json(await Division.find().sort({ createdAt: -1 }));
  }
  catch (e) {
    res.status(500).json({ mensaje: 'Error al obtener divisiones' });
  }
});

app.post('/divisiones', verificarToken, soloAdmin, async (req, res) => {
  try {
    const division = await new Division(req.body).save();
    res.status(201).json(division);
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al crear división' });
  }
});

app.put('/divisiones/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const division = await Division.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
    if (!division) return res.status(404).json({ mensaje: 'División no encontrada' });
    res.json(division);
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al actualizar división' });
  }
});

app.delete('/divisiones/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    await Division.findByIdAndDelete(req.params.id);
    res.json({ mensaje: 'División eliminada' });
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al eliminar división' });
  }
});

crudRoutes(app, '/profesores', Profesor, [soloAdmin]);

app.post('/noticias', verificarToken, soloAdmin, async (req, res) => {
  try {
    const noticia = new Noticia(req.body);
    await noticia.save();
    res.status(201).json(noticia);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al crear noticia' });
  }
});

app.put('/noticias/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const noticia = await Noticia.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
    if (!noticia) return res.status(404).json({ mensaje: 'Noticia no encontrada' });
    res.json(noticia);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al actualizar noticia' });
  }
});

app.delete('/noticias/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    await Noticia.findByIdAndDelete(req.params.id);
    res.json({ mensaje: 'Noticia eliminada' });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al eliminar noticia' });
  }
});

app.put('/config', verificarToken, soloAdmin, async (req, res) => {
  try {
    let config = await SiteConfig.findOne();
    if (!config) {
      config = await SiteConfig.create(req.body);
    } else {
      config = await SiteConfig.findByIdAndUpdate(
        config._id,
        { $set: req.body },
        { returnDocument: 'after', runValidators: false }
      );
    }
    res.json(config);
  } catch (error) {
    console.error('Error al guardar config:', error.message);
    res.status(500).json({ mensaje: 'Error al guardar configuración', detalle: error.message });
  }
});
app.get('/pagos', verificarToken, soloAdmin, async (req, res) => {
  try {
    const filtro = {};
    if (req.query.estado) {
      const estados = req.query.estado.split(',').map(e => e.trim()).filter(Boolean);
      filtro.estado = estados.length > 1 ? { $in: estados } : estados[0];
    }
    const pagos = await Pago.find(filtro).select('-voucherBase64').sort({ fechaRegistro: -1 });
    res.json(pagos);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener pagos' });
  }
});

app.get('/pagos/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const pago = await Pago.findById(req.params.id);
    if (!pago) return res.status(404).json({ mensaje: 'Pago no encontrado' });
    res.json(pago);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener pago' });
  }
});

app.patch('/pagos/:id/estado', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { estado } = req.body;

    if (!['pendiente', 'aprobado', 'rechazado'].includes(estado)) {
      return res.status(400).json({ mensaje: 'Estado invalido' });
    }

    const pagoActualizado = await Pago.findByIdAndUpdate(
      req.params.id,
      { estado },
      { returnDocument: 'after' }
    );

    if (!pagoActualizado) {
      return res.status(404).json({ mensaje: 'Pago no encontrado' });
    }

    if (estado === 'aprobado') {
      let fichaId = pagoActualizado.fichaId;
      if (!fichaId) {
        const match = (pagoActualizado.alumno || '').match(/\(([^)]+)\)/);
        if (match) {
          const cedula = match[1].trim();
          if (cedula && cedula !== 'sin RUT') {
            const ficha = await FichaTemporada.findOne({ cedula });
            if (ficha) fichaId = ficha._id;
          }
        }
      }
      if (fichaId) {
        const fechaPago = pagoActualizado.fecha ? new Date(pagoActualizado.fecha) : new Date();
        const mes = fechaPago.getMonth() + 1;
        const año = fechaPago.getFullYear();
        await PagoMensual.findOneAndUpdate(
          { fichaId, mes, año },
          { estado: 'pagado', fechaPago: new Date(), observacion: 'Aprobado por voucher' },
          { upsert: true, returnDocument: 'after' }
        );
      }
    }

    res.json(pagoActualizado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al actualizar el pago' });
  }
});

app.get('/inscripciones', verificarToken, soloAdmin, async (req, res) => {
  try {
    const data = await Inscripcion.find().sort({ fechaRegistro: -1 });
    res.json(data);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener datos' });
  }
});

app.put('/aprobar/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const inscripcion = await Inscripcion.findById(req.params.id);

    if (!inscripcion) {
      return res.status(404).json({
        mensaje: 'Inscripción no encontrada'
      });
    }

    if (inscripcion.estado === 'aprobado') {
      return res.status(400).json({
        mensaje: 'La inscripción ya fue aprobada'
      });
    }

    const nombreApoderado = inscripcion.apoderado.nombre?.trim();
    const apellidos = inscripcion.apoderado.apellidos?.trim() || '';

    const apellidoPrincipal = apellidos.split(' ')[0] || 'user';

    const email = generarUsuario(nombreApoderado, apellidoPrincipal);
    const passwordTemporal = generarClaveTemporal();

    const existeUsuario = await UsuarioSistema.findOne({ email });

    if (!existeUsuario) {
      const passwordHash = await bcrypt.hash(passwordTemporal, 10);

      await new UsuarioSistema({
        nombre: `${nombreApoderado} ${apellidos}`,
        email,
        passwordHash,
        rol: 'cliente',
        estado: 'activo',
        debeCambiarPassword: true,
        inscripcionId: inscripcion._id
      }).save();
    }

    inscripcion.estado = 'aprobado';
    await inscripcion.save();

    res.json({
      mensaje: 'Inscripción aprobada correctamente',
      credenciales: {
        email,
        passwordTemporal
      }
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      mensaje: 'Error al aprobar inscripción'
    });
  }
});

app.put('/rechazar/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    await Inscripcion.findByIdAndUpdate(req.params.id, { estado: 'rechazado' });
    res.json({ mensaje: 'Rechazado' });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al rechazar' });
  }
});

/* VISTA CLIENTE */
app.get('/cliente/mi-ficha', verificarToken, async (req, res) => {
  try {
    const email = req.user.email;
    if (!email) return res.status(400).json({ mensaje: 'Token sin email' });
    const ficha = await FichaTemporada.findOne({ 'apoderado.correo': { $regex: new RegExp(`^${email}$`, 'i') } });
    if (!ficha) return res.status(404).json({ mensaje: 'No se encontró ficha asociada a este correo' });
    res.json(ficha);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al obtener ficha' });
  }
});

// Devuelve TODAS las fichas del apoderado (por si tiene varios hijos registrados)
app.get('/cliente/mis-fichas', verificarToken, async (req, res) => {
  try {
    const email = req.user.email;
    if (!email) return res.status(400).json({ mensaje: 'Token sin email' });
    const fichas = await FichaTemporada.find({ 'apoderado.correo': { $regex: new RegExp(`^${email}$`, 'i') } });
    res.json(fichas);
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al obtener fichas' });
  }
});

/* Crea (si no existe) la cuenta cliente de un apoderado y le manda el correo de activación.
   Se usa tanto desde el botón manual del admin como automáticamente al registrar una ficha. */
async function crearCuentaClienteConActivacion(email, nombre) {
  const existe = await UsuarioSistema.findOne({ email });
  if (existe) return { creada: false, motivo: 'ya_existe' };

  // Password aleatoria de relleno: nadie la usa, la cuenta se activa por link de correo
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const activacionToken = crypto.randomBytes(24).toString('hex');
  const activacionExpira = new Date(Date.now() + 72 * 60 * 60 * 1000);

  await new UsuarioSistema({
    nombre: nombre || 'Apoderado',
    email,
    passwordHash,
    rol: 'cliente',
    estado: 'pendiente',
    debeCambiarPassword: true,
    activacionToken,
    activacionExpira,
  }).save();

  const resultadoCorreo = await enviarCorreoActivacionApoderado(email, nombre, activacionToken);

  return {
    creada: true,
    correoEnviado: resultadoCorreo.enviado,
    linkActivacion: `${process.env.FRONTEND_URL || 'https://www.captaciones.cl'}/activar-cuenta/${activacionToken}`,
  };
}

app.post('/admin/crear-cliente-ficha/:fichaId', verificarToken, soloAdmin, async (req, res) => {
  try {
    const ficha = await FichaTemporada.findById(req.params.fichaId);
    if (!ficha) return res.status(404).json({ mensaje: 'Ficha no encontrada' });

    const email = ficha.apoderado?.correo;
    if (!email) return res.status(400).json({ mensaje: 'La ficha no tiene correo de apoderado' });

    const resultado = await crearCuentaClienteConActivacion(email, ficha.apoderado.nombre);
    if (!resultado.creada) return res.status(400).json({ mensaje: 'Ya existe una cuenta con ese correo' });

    res.status(201).json({
      mensaje: resultado.correoEnviado
        ? 'Cuenta creada. Se envió un correo de activación al apoderado.'
        : 'Cuenta creada, pero no se pudo enviar el correo automático (revisa la configuración de SMTP). Comparte este link manualmente:',
      email,
      correoEnviado: resultado.correoEnviado,
      linkActivacion: resultado.linkActivacion,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al crear cuenta cliente' });
  }
});

/* Verifica un token de activación de cuenta (público, sin login) */
app.get('/activar-cuenta/:token', async (req, res) => {
  try {
    const usuario = await UsuarioSistema.findOne({ activacionToken: req.params.token });
    if (!usuario) return res.status(404).json({ mensaje: 'Link de activación inválido' });
    if (usuario.activacionExpira < new Date()) return res.status(410).json({ mensaje: 'Este link ha expirado' });
    res.json({ valido: true, email: usuario.email, nombre: usuario.nombre });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al validar el link' });
  }
});

/* Activa la cuenta: confirma el correo y define la contraseña propia del apoderado */
app.post('/activar-cuenta/:token', limiteLogin, async (req, res) => {
  try {
    const { passwordNueva } = req.body;
    if (!passwordNueva || passwordNueva.length < 8) {
      return res.status(400).json({ mensaje: 'La contraseña debe tener al menos 8 caracteres' });
    }
    const usuario = await UsuarioSistema.findOne({ activacionToken: req.params.token });
    if (!usuario) return res.status(404).json({ mensaje: 'Link de activación inválido' });
    if (usuario.activacionExpira < new Date()) return res.status(410).json({ mensaje: 'Este link ha expirado' });

    usuario.passwordHash = await bcrypt.hash(passwordNueva, 10);
    usuario.estado = 'activo';
    usuario.debeCambiarPassword = false;
    usuario.activacionToken = null;
    usuario.activacionExpira = null;
    await usuario.save();

    res.json({ mensaje: 'Cuenta activada correctamente. Ya puedes iniciar sesión.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al activar la cuenta' });
  }
});

/* RUTAS PROFESOR */

function soloProfesor(req, res, next) {
  if (req.user.rol !== 'profesor') return res.status(403).json({ mensaje: 'Acceso solo para profesores' });
  next();
}

// Construye el filtro de fichas para un profesor (categoría + sede)
// Usa regex case-insensitive para cada división para evitar problemas de mayúsculas/espacios
function fichaQueryProfesor(prof) {
  const divs = (prof.divisiones || []).filter(Boolean);
  if (!divs.length) return null; // sin divisiones → sin fichas
  const regexDivs = divs.map(d => new RegExp(`^${d.trim()}$`, 'i'));
  const q = { categoria: { $in: regexDivs } };
  if (prof.sede) q.sede = { $regex: new RegExp(prof.sede.trim(), 'i') };
  return q;
}

// Verifica que un jugador esté dentro de las divisiones/sede asignadas al profesor
async function jugadorPerteneceAProfesor(jugadorId, prof) {
  if (!mongoose.Types.ObjectId.isValid(jugadorId)) return false;
  const query = fichaQueryProfesor(prof);
  if (!query) return false;
  const ficha = await FichaTemporada.findOne({ _id: jugadorId, ...query }).select('_id');
  return !!ficha;
}

app.get('/profesor/mi-perfil', verificarToken, soloProfesor, async (req, res) => {
  try {
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    if (!usuario?.profesorId) return res.status(404).json({ mensaje: 'Perfil no encontrado' });
    res.json(usuario.profesorId);
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener perfil' }); }
});

app.get('/profesor/mis-fichas', verificarToken, soloProfesor, async (req, res) => {
  try {
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    if (!usuario?.profesorId) return res.status(404).json({ mensaje: 'Perfil no encontrado' });
    const prof = usuario.profesorId;
    const query = fichaQueryProfesor(prof);
    if (!query) return res.json([]);
    const fichas = await FichaTemporada.find(query).sort({ nombre: 1 });
    res.json(fichas);
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener fichas' }); }
});

// Migración: convierte fichas con formato CSV-roto al esquema correcto
app.post('/admin/migracion-fichas-csv', verificarToken, soloAdmin, async (req, res) => {
  try {
    const fichas = await FichaTemporada.find({}).lean();
    let migradas = 0;
    const erroresList = [];

    const limpiar = v => {
      if (v === undefined || v === null) return '';
      const t = String(v).trim();
      return /^faltante$/i.test(t) || t === '0' ? '' : t;
    };

    const normalizarCategoria = v => {
      if (!v) return '';
      const m = v.trim().match(/^sub[-_\s]?(\d+)$/i);
      return m ? `Sub-${m[1]}` : v.trim();
    };

    const parsearFecha = v => {
      if (!v) return null;
      // "2008-00-00" → usa solo el año con día 1 enero
      const parts = v.split('-');
      if (parts.length < 1) return null;
      const y = parseInt(parts[0]);
      if (isNaN(y) || y < 1980 || y > 2030) return null;
      const m = parseInt(parts[1]) || 1;
      const d = parseInt(parts[2]) || 1;
      const fecha = new Date(y, (m < 1 ? 1 : m) - 1, d < 1 ? 1 : d);
      return isNaN(fecha.getTime()) ? null : fecha;
    };

    for (const doc of fichas) {
      // Detectar campo con formato CSV (clave contiene ';')
      const csvKey = Object.keys(doc).find(k => k.includes(';'));
      if (!csvKey) continue; // Documento ya tiene formato correcto

      try {
        const headers = csvKey.split(';').map(h => h.trim());
        const rawVal  = String(doc[csvKey] || '');
        // split por ';' respetando que puede haber espacios
        const valores = rawVal.split(';');

        const map = {};
        headers.forEach((h, i) => { map[h] = limpiar(valores[i] || ''); });

        const update = {
          nombre:          map.nombre          || map.Nombre          || '',
          apellidoPaterno: map.apellidoPaterno || map.ApellidoPaterno || '',
          apellidoMaterno: map.apellidoMaterno || map.ApellidoMaterno || '',
          categoria:       normalizarCategoria(map.categoria || map.Categoria || ''),
          clubAmateur:     map.clubAmateur     || map.ClubAmateur     || '',
          posicion:        map.posicion        || map.Posicion        || '',
        };

        // cedula / rut
        const ced = map.cedula || map.rut || map.Cedula || map.Rut || '';
        if (ced) update.cedula = ced;

        // apellido combinado para compatibilidad
        update.apellido = [update.apellidoPaterno, update.apellidoMaterno].filter(Boolean).join(' ');

        // fecha de nacimiento
        const fechaStr = map.fechaNacimiento || map.FechaNacimiento || '';
        const fechaDate = parsearFecha(fechaStr);
        if (fechaDate) {
          update.fechaNacimiento = fechaDate;
          update.edad = calcularEdad(fechaDate.toISOString());
          if (!update.categoria) update.categoria = obtenerCategoria(fechaDate.toISOString());
        }

        // Usar updateOne directo para poder hacer $unset del campo roto
        await FichaTemporada.collection.updateOne(
          { _id: doc._id },
          { $set: update, $unset: { [csvKey]: '' } }
        );
        migradas++;
      } catch (eInner) {
        erroresList.push({ id: doc._id, error: eInner.message });
      }
    }

    res.json({
      mensaje: `Migración completada: ${migradas} fichas convertidas.`,
      errores: erroresList.length,
      detalleErrores: erroresList
    });
  } catch (e) {
    res.status(500).json({ mensaje: 'Error en migración', detalle: e.message });
  }
});

// Helper: construye el apellido de display a partir de los campos disponibles
function apellidoDisplay(f) {
  if (f.apellidoPaterno) {
    return f.apellidoMaterno ? `${f.apellidoPaterno} ${f.apellidoMaterno}` : f.apellidoPaterno;
  }
  return f.apellido || '';
}

// Libro de asistencia — admin (todos los jugadores del mes, filtro opcional de categoría y sede)
app.get('/admin/asistencias/libro', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { mes, categoria, sede } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes))
      return res.status(400).json({ mensaje: 'Parámetro mes requerido (formato YYYY-MM)' });
    const [anio, mesNum] = mes.split('-').map(Number);
    const inicio = new Date(anio, mesNum - 1, 1);
    const fin    = new Date(anio, mesNum,     1);
    const fichaQuery = {};
    if (categoria) fichaQuery.categoria = categoria;
    if (sede) fichaQuery.sede = { $regex: new RegExp(sede, 'i') };
    const fichas = await FichaTemporada.find(fichaQuery).sort({ apellido: 1, nombre: 1 });
    const fichaIds = fichas.map(f => f._id);
    const asistencias = await Asistencia.find({ jugadorId: { $in: fichaIds }, fecha: { $gte: inicio, $lt: fin } });
    console.log('[LIBRO-ADMIN] fichas:', fichas.length, '| asistencias:', asistencias.length, '| rango:', inicio.toISOString(), '-', fin.toISOString());
    const isoFecha = d => { const dt = new Date(d); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; };
    const fechas = [...new Set(asistencias.map(a => isoFecha(a.fecha)))].sort();
    const jugadores = fichas.map(f => {
      const mis = asistencias.filter(a => a.jugadorId.toString() === f._id.toString());
      const registros = {};
      mis.forEach(a => { registros[isoFecha(a.fecha)] = a.estado; });
      const asistio     = mis.filter(a => a.estado === 'asistio').length;
      const licenciado  = mis.filter(a => a.estado === 'licenciado').length;
      const justificado = mis.filter(a => a.estado === 'justificado').length;
      const ausente     = mis.filter(a => a.estado === 'ausente').length;
      const totalClases = fechas.length;
      // P y L cuentan como asistido (100%). J y A cuentan como 0%.
      const porcentaje = totalClases > 0 ? Math.round((asistio + licenciado) / totalClases * 100) : null;
      return {
        _id: f._id, nombre: f.nombre,
        apellidoPaterno: f.apellidoPaterno || '',
        apellidoMaterno: f.apellidoMaterno || '',
        apellido: apellidoDisplay(f),
        categoria: f.categoria, sede: f.sede || '', registros, totalClases, asistio, licenciado, justificado, ausente, porcentaje
      };
    });
    res.json({ fechas, jugadores });
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener libro', detalle: e.message }); }
});

// Libro de asistencia — profesor (solo sus divisiones)
app.get('/profesor/asistencias/libro', verificarToken, soloProfesor, async (req, res) => {
  try {
    const { mes } = req.query;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes))
      return res.status(400).json({ mensaje: 'Parámetro mes requerido (formato YYYY-MM)' });
    const [anio, mesNum] = mes.split('-').map(Number);
    const inicio = new Date(anio, mesNum - 1, 1);
    const fin    = new Date(anio, mesNum,     1);
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    if (!usuario?.profesorId) return res.status(404).json({ mensaje: 'Perfil no encontrado' });
    const prof = usuario.profesorId;
    console.log('[LIBRO] divisiones:', prof.divisiones, '| sede:', prof.sede);
    const query = fichaQueryProfesor(prof);
    if (!query) return res.json({ fechas: [], jugadores: [] });
    const fichas = await FichaTemporada.find(query).sort({ apellido: 1, nombre: 1 });
    console.log('[LIBRO] fichas encontradas:', fichas.length);
    const fichaIds = fichas.map(f => f._id);
    const asistencias = await Asistencia.find({ jugadorId: { $in: fichaIds }, fecha: { $gte: inicio, $lt: fin } });
    console.log('[LIBRO] asistencias encontradas:', asistencias.length, '| rango:', inicio.toISOString(), '-', fin.toISOString());
    const isoFecha = d => { const dt = new Date(d); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; };
    const fechas = [...new Set(asistencias.map(a => isoFecha(a.fecha)))].sort();
    const jugadores = fichas.map(f => {
      const mis = asistencias.filter(a => a.jugadorId.toString() === f._id.toString());
      const registros = {};
      mis.forEach(a => { registros[isoFecha(a.fecha)] = a.estado; });
      const asistio     = mis.filter(a => a.estado === 'asistio').length;
      const licenciado  = mis.filter(a => a.estado === 'licenciado').length;
      const justificado = mis.filter(a => a.estado === 'justificado').length;
      const ausente     = mis.filter(a => a.estado === 'ausente').length;
      const totalClases = fechas.length;
      const porcentaje = totalClases > 0 ? Math.round((asistio + licenciado) / totalClases * 100) : null;
      return {
        _id: f._id, nombre: f.nombre,
        apellidoPaterno: f.apellidoPaterno || '',
        apellidoMaterno: f.apellidoMaterno || '',
        apellido: apellidoDisplay(f),
        categoria: f.categoria, sede: f.sede, registros, totalClases, asistio, licenciado, justificado, ausente, porcentaje
      };
    });
    res.json({ fechas, jugadores });
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener libro', detalle: e.message }); }
});

app.get('/profesor/asistencias', verificarToken, soloProfesor, async (req, res) => {
  try {
    const { fecha } = req.query;
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    if (!usuario?.profesorId) return res.status(404).json({ mensaje: 'Perfil no encontrado' });
    const query = fichaQueryProfesor(usuario.profesorId);
    if (!query) return res.json([]);
    const fichas = await FichaTemporada.find(query).select('_id');
    const fichaIds = fichas.map(f => f._id);
    const filtro = { jugadorId: { $in: fichaIds } };
    if (fecha) {
      filtro.fecha = {
        $gte: new Date(`${fecha}T00:00:00`),
        $lte: new Date(`${fecha}T23:59:59`)
      };
    }
    const asistencias = await Asistencia.find(filtro);
    res.json(asistencias);
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener asistencias' }); }
});

// Normalizar sedes de fichastemporadas (VIÑA → Viña del Mar, OLMUÉ → Olmué, etc.)
app.post('/admin/normalizar-sedes', verificarToken, soloAdmin, async (req, res) => {
  try {
    const mapa = {
      'viña': 'Viña del Mar',
      'viña del mar': 'Viña del Mar',
      'olmué': 'Olmué',
      'olmue': 'Olmué',
    };
    const fichas = await FichaTemporada.find({ sede: { $exists: true } }).select('_id sede nombre').lean();
    let actualizadas = 0;
    const detalles = [];
    for (const f of fichas) {
      const key = (f.sede || '').trim().toLowerCase();
      const nueva = mapa[key];
      if (nueva && nueva !== f.sede) {
        await FichaTemporada.updateOne({ _id: f._id }, { $set: { sede: nueva } });
        detalles.push(`${f.nombre}: "${f.sede}" → "${nueva}"`);
        actualizadas++;
      }
    }
    res.json({ mensaje: `${actualizadas} fichas actualizadas`, detalles });
  } catch (e) { res.status(500).json({ mensaje: 'Error al normalizar sedes', detalle: e.message }); }
});

// Editar una asistencia individual — admin
app.put('/admin/asistencias/editar', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { jugadorId, fecha, estado } = req.body;
    if (!jugadorId || !fecha || !estado) return res.status(400).json({ mensaje: 'jugadorId, fecha y estado son requeridos' });
    const fechaNorm = new Date(`${fecha}T00:00:00`);
    const asistencia = await Asistencia.findOneAndUpdate(
      { jugadorId, fecha: fechaNorm },
      { jugadorId, fecha: fechaNorm, estado },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(asistencia);
  } catch (e) { res.status(500).json({ mensaje: 'Error al editar asistencia', detalle: e.message }); }
});

app.post('/profesor/asistencias/lote', verificarToken, soloProfesor, async (req, res) => {
  try {
    const { fecha, registros } = req.body;
    if (!fecha || !Array.isArray(registros)) {
      return res.status(400).json({ mensaje: 'Fecha y registros son obligatorios' });
    }
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    const profesorId = usuario.profesorId?._id;
    const fechaNormalizada = new Date(`${fecha}T00:00:00`);
    const resultados = [];
    for (const r of registros) {
      const { jugadorId, estado } = r;
      const asistencia = await Asistencia.findOneAndUpdate(
        { jugadorId, fecha: fechaNormalizada },
        { jugadorId, fecha: fechaNormalizada, estado, profesorId },
        { upsert: true, returnDocument: 'after' }
      );
      resultados.push(asistencia);
    }
    res.json({ mensaje: 'Asistencias guardadas', total: resultados.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: 'Error al guardar asistencias' });
  }
});

/* ── VINCULAR PAGO APROBADO → PAGO MENSUAL (retroactivo) ── */
app.post('/admin/vincular-pago-mensual/:pagoId', verificarToken, soloAdmin, async (req, res) => {
  try {
    const pago = await Pago.findById(req.params.pagoId);
    if (!pago) return res.status(404).json({ mensaje: 'Pago no encontrado' });
    if (pago.estado !== 'aprobado') return res.status(400).json({ mensaje: 'El pago no está aprobado' });

    let fichaId = pago.fichaId;
    if (!fichaId) {
      const match = (pago.alumno || '').match(/\(([^)]+)\)/);
      if (match) {
        const cedula = match[1].trim();
        if (cedula && cedula !== 'sin RUT') {
          const ficha = await FichaTemporada.findOne({ cedula });
          if (ficha) fichaId = ficha._id;
        }
      }
    }
    if (!fichaId) return res.status(404).json({ mensaje: 'No se pudo identificar al jugador. Verifica que el RUT en el voucher coincida con el de la ficha.' });

    // Usar MES ACTUAL para el registro (no la fecha del voucher, que puede ser de otro mes)
    const hoy = new Date();
    const mes = hoy.getMonth() + 1;
    const año = hoy.getFullYear();

    const pagoMensual = await PagoMensual.findOneAndUpdate(
      { fichaId, mes, año },
      { estado: 'pagado', fechaPago: new Date(), observacion: 'Vinculado manualmente por admin' },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ mensaje: 'Pago mensual actualizado', mes, año, pagoMensual });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: 'Error al vincular pago mensual' });
  }
});

/* ── PAGOS MENSUALES ────────────────────────────── */
app.put('/admin/pago-mensual/:fichaId', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { estado, observacion } = req.body;
    const hoy = new Date();
    const pago = await PagoMensual.findOneAndUpdate(
      { fichaId: req.params.fichaId, mes: hoy.getMonth() + 1, año: hoy.getFullYear() },
      { estado, observacion, fechaPago: estado === 'pagado' ? new Date() : undefined },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(pago);
  } catch (e) { res.status(500).json({ mensaje: 'Error al actualizar pago' }); }
});

app.get('/cliente/mis-pagos-mensuales', verificarToken, async (req, res) => {
  try {
    const { fichaId } = req.query;
    const query = fichaId
      ? { _id: fichaId, 'apoderado.correo': { $regex: new RegExp(`^${req.user.email}$`, 'i') } }
      : { 'apoderado.correo': { $regex: new RegExp(`^${req.user.email}$`, 'i') } };
    const ficha = await FichaTemporada.findOne(query);
    if (!ficha) return res.status(404).json({ mensaje: 'Ficha no encontrada' });
    const hoy = new Date();
    const mes = hoy.getMonth() + 1;
    const año = hoy.getFullYear();
    const pagos = await PagoMensual.find({ fichaId: ficha._id }).sort({ año: -1, mes: -1 }).limit(6);
    const pagoActual = pagos.find(p => p.mes === mes && p.año === año);

    // Verificar si hay un voucher enviado este mes para este jugador
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const finMes    = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
    const voucherActivo = await Pago.findOne({
      fichaId: ficha._id,
      fechaRegistro: { $gte: inicioMes, $lt: finMes }
    }).sort({ fechaRegistro: -1 });

    res.json({
      mesActual: { mes, año, estado: pagoActual?.estado || 'pendiente', monto: 20000 },
      historial: pagos,
      voucherMesActual: voucherActivo
        ? { existe: true, estado: voucherActivo.estado }
        : { existe: false, estado: null }
    });
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener pagos' }); }
});

/* ── RENDIMIENTO ────────────────────────────────── */
app.post('/profesor/rendimiento', verificarToken, soloProfesor, async (req, res) => {
  try {
    const { fecha, registros } = req.body;
    const fechaObj = new Date(fecha);
    const resultados = [];
    for (const r of registros) {
      const rend = await Rendimiento.findOneAndUpdate(
        { jugadorId: r.jugadorId, fecha: fechaObj },
        { jugadorId: r.jugadorId, profesorEmail: req.user.email, fecha: fechaObj,
          fisico: r.fisico, tecnico: r.tecnico, psicologico: r.psicologico,
          estrategico: r.estrategico, notas: r.notas || '' },
        { upsert: true, returnDocument: 'after' }
      );
      resultados.push(rend);
    }
    res.json({ mensaje: 'Rendimiento guardado', total: resultados.length });
  } catch (e) { res.status(500).json({ mensaje: 'Error al guardar rendimiento' }); }
});

app.get('/profesor/rendimiento', verificarToken, soloProfesor, async (req, res) => {
  try {
    const { fecha } = req.query;
    const usuario = await UsuarioSistema.findById(req.user.id).populate('profesorId');
    const query = fichaQueryProfesor(usuario?.profesorId || {});
    if (!query) return res.json([]);
    const fichas = await FichaTemporada.find(query).select('_id');
    const fichaIds = fichas.map(f => f._id);
    const filtro = { jugadorId: { $in: fichaIds } };
    if (fecha) filtro.fecha = new Date(fecha);
    const rendimientos = await Rendimiento.find(filtro);
    res.json(rendimientos);
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener rendimiento' }); }
});

app.get('/admin/rendimiento/:jugadorId', verificarToken, soloAdmin, async (req, res) => {
  try {
    const rendimientos = await Rendimiento.find({ jugadorId: req.params.jugadorId }).sort({ fecha: -1 }).limit(20);
    res.json(rendimientos);
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener rendimiento' }); }
});

app.put('/admin/rendimiento/:id', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { fisico, tecnico, actitudinal, estrategico, comentario, actitudAdversidad } = req.body;
    if (!fisico || !tecnico || !actitudinal || !estrategico) {
      return res.status(400).json({ mensaje: 'fisico, tecnico, actitudinal y estrategico son obligatorios' });
    }

    const fProm = promedioCategoria(fisico);
    const tProm = promedioCategoria(tecnico);
    const aProm = promedioCategoria(actitudinal);
    const eProm = promedioCategoria(estrategico);
    const promedioGeneral = Math.round((fProm + tProm + aProm + eProm) / 4);

    const rendimiento = await Rendimiento.findByIdAndUpdate(
      req.params.id,
      {
        fisico: { ...fisico, promedio: fProm },
        tecnico: { ...tecnico, promedio: tProm },
        actitudinal: { ...actitudinal, promedio: aProm },
        estrategico: { ...estrategico, promedio: eProm },
        promedioGeneral,
        comentario: comentario || '',
        actitudAdversidad: actitudAdversidad || '',
      },
      { returnDocument: 'after', runValidators: false }
    );
    if (!rendimiento) return res.status(404).json({ mensaje: 'Rendimiento no encontrado' });
    res.json(rendimiento);
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al editar rendimiento' });
  }
});

app.get('/cliente/mi-rendimiento', verificarToken, async (req, res) => {
  try {
    let ficha;
    if (req.query.fichaId) {
      // Verificar que la ficha pertenece al apoderado
      ficha = await FichaTemporada.findOne({ _id: req.query.fichaId, 'apoderado.correo': { $regex: new RegExp(`^${req.user.email}$`, 'i') } });
    } else {
      ficha = await FichaTemporada.findOne({ 'apoderado.correo': { $regex: new RegExp(`^${req.user.email}$`, 'i') } });
    }
    if (!ficha) return res.status(404).json({ mensaje: 'Ficha no encontrada' });

    const rendimientos = await Rendimiento.find({ jugadorId: ficha._id }).sort({ fecha: 1 });
    if (!rendimientos.length) return res.json({ promedio: null, historial: [] });

    const avg = (campo) =>
      Math.round(rendimientos.reduce((s, r) => s + (r[campo]?.promedio || 0), 0) / rendimientos.length);

    res.json({
      promedio: {
        fisico:      avg('fisico'),
        tecnico:     avg('tecnico'),
        actitudinal: avg('actitudinal'),
        estrategico: avg('estrategico'),
        general:     Math.round(rendimientos.reduce((s, r) => s + (r.promedioGeneral || 0), 0) / rendimientos.length),
        sesiones:    rendimientos.length
      },
      historial: rendimientos.map(r => ({
        fecha:       r.fecha,
        fisico:      r.fisico?.promedio || 0,
        tecnico:     r.tecnico?.promedio || 0,
        actitudinal: r.actitudinal?.promedio || 0,
        estrategico: r.estrategico?.promedio || 0,
        general:     r.promedioGeneral || 0,
        comentario:  r.comentario
      }))
    });
  } catch (e) { res.status(500).json({ mensaje: 'Error al obtener rendimiento' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});