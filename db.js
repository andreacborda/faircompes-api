// db.js
// Conexión a PostgreSQL (Render). Se usa desde index.js para todo lo
// relacionado con usuarios, verificación, sesiones y trial.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render requiere SSL
});

module.exports = { pool };
