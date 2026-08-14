const mongoose = require('mongoose');

const PartidoSchema = new mongoose.Schema({
  local:      { type: String, default: 'Santiago Wanderers' },
  visitante:  { type: String, required: true },
  fecha:      { type: String },
  hora:       { type: String },
  horaCitacion: { type: String },
  resultado:  { type: String, default: '' },
  sede:       { type: String },
  tipo:       { type: String, enum: ['proximo', 'resultado'], default: 'proximo' },
}, { timestamps: true });

module.exports = mongoose.model('Partido', PartidoSchema);
