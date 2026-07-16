const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const result = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'users'
    ORDER BY ordinal_position;
  `);
  console.log("Columnas de la tabla users:");
  result.rows.forEach(r => console.log(`- ${r.column_name} (${r.data_type})`));
  await pool.end();
}

check().catch(err => console.error("Error:", err.message));