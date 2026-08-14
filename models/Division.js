const mongoose = require('mongoose');

const DivisionSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  categoria: String,
  profesorPrincipal: String,
  estudiantes: { type: Number, default: 0 },
  sede: String,
  horarioEntrenamiento: {
    lunes: String,
    martes: String,
    miercoles: String,
    jueves: String,
    viernes: String,
    sabado: String,
    domingo: String,
  },
}, { timestamps: true });

module.exports = mongoose.model('Division', DivisionSchema);
