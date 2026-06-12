import postgres from 'postgres';

const PRODUCTION_DATABASE_URL = process.env.PRODUCTION_DATABASE_URL;

if (!PRODUCTION_DATABASE_URL) {
  console.error('❌ PRODUCTION_DATABASE_URL not set');
  process.exit(1);
}

async function dropSchemas() {
  const sql = postgres(PRODUCTION_DATABASE_URL, {
    onnotice: () => {}, // suppress notices
  });

  try {
    console.log('🔗 Connected to production database');

    // Get all user-defined schemas
    const schemas: Array<{ schema_name: string }> = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_toast_temp_1')
      ORDER BY schema_name
    `;

    console.log(`📦 Found ${schemas.length} schemas to drop:\n`);

    for (const { schema_name } of schemas) {
      try {
        console.log(`  Dropping schema: ${schema_name}...`);
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`);
        console.log(`    ✓ Success`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`    ✗ Error: ${message}`);
      }
    }

    console.log('\n✅ All schemas dropped successfully');
    await sql.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Error:', message);
    process.exit(1);
  }
}

dropSchemas();
