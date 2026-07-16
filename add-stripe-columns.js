const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function addColumns() {
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR,
    ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR;
  `);
  console.log("Columnas agregadas correctamente.");
  await pool.end();
}

addColumns().catch(err => console.error("Error:", err.message));