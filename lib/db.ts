import { Pool } from "pg";

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.BD_POSTGRES;
    if (!connectionString) {
      throw new Error(
        "BD_POSTGRES no está configurada en .env. Agrega la connection string de Neon.",
      );
    }

    // Quitamos sslmode y channel_binding de la URL para evitar el warning de deprecación
    // de pg-connection-string v8 (estos parámetros se manejan vía la opción `ssl` del Pool).
    const cleanedUrl = connectionString
      .replace(/[?&]sslmode=[^&]*/g, "")
      .replace(/[?&]channel_binding=[^&]*/g, "")
      // Limpiar ? o & huérfanos que queden al final
      .replace(/[?&]+$/, "");

    pool = new Pool({
      connectionString: cleanedUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on("error", (err) => {
      console.error("Error inesperado en el pool de Postgres:", err.message);
    });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
