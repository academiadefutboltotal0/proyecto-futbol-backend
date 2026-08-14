const mongoose = require('mongoose');

const SiteConfigSchema = new mongoose.Schema({
  tituloHeader:        { type: String, default: 'Escuela de Futbol - Inicio' },
  kickerHero:          { type: String, default: 'Escuela Familias del Fútbol' },
  tituloBienvenida:    { type: String, default: '¡Bienvenidos Crack!' },
  subtituloBienvenida: { type: String, default: 'Revisa las últimas novedades de tu club.' },
  imagenDestacada:     { type: String, default: '' },
  imagenesCarrusel:    { type: [String], default: [] },
  imagenesGaleria:     { type: [{ url: String, descripcion: String }], default: [] },
  mostrarPopup:        { type: Boolean, default: false },
  imagenPopup:         { type: String, default: '' },
  tituloPopup:         { type: String, default: '' },
  cuerpoPopup:         { type: String, default: '' },
  sedes:               { type: [String], default: ['Viña del Mar', 'Olmué'] },
});

module.exports = mongoose.model('SiteConfig', SiteConfigSchema);
