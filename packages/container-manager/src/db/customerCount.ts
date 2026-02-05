import pg from 'pg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

// Get current file directory (ESM compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to docker compose directory to read env files
const COMPOSE_DIR = path.resolve(__dirname, '../../../../docker/supabase');

interface DbCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

async function getDbCredentials(projectName: string): Promise<DbCredentials | null> {
  try {
    const envPath = path.join(COMPOSE_DIR, `.env.${projectName}`);
    const envContent = await fs.readFile(envPath, 'utf-8');
    
    const passwordMatch = envContent.match(/POSTGRES_PASSWORD=(.+)/);
    const password = passwordMatch ? passwordMatch[1].trim() : null;
    
    if (!password) {
      return null;
    }

    // Extract the DB_EXTERNAL_PORT for this instance
    const dbPortMatch = envContent.match(/DB_EXTERNAL_PORT=(\d+)/);
    const dbPort = dbPortMatch ? parseInt(dbPortMatch[1], 10) : 54322;
    
    return {
      host: 'localhost',
      port: dbPort,
      user: 'postgres',
      password,
      database: 'postgres',
    };
  } catch {
    return null;
  }
}

export async function getCustomerCount(projectName: string): Promise<number | null> {
  const credentials = await getDbCredentials(projectName);
  
  if (!credentials) {
    return null;
  }

  const pool = new Pool({
    ...credentials,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    max: 1,
  });

  try {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM stripe.customers'
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  } catch (error) {
    // Table might not exist yet or connection failed
    return null;
  } finally {
    await pool.end();
  }
}

export async function getDbStats(projectName: string): Promise<{
  customerCount: number | null;
  subscriptionCount: number | null;
  productCount: number | null;
  invoiceCount: number | null;
} | null> {
  const credentials = await getDbCredentials(projectName);
  
  if (!credentials) {
    return null;
  }

  const pool = new Pool({
    ...credentials,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    max: 1,
  });

  try {
    const queries = [
      pool.query('SELECT COUNT(*) as count FROM stripe.customers').catch(() => ({ rows: [{ count: null }] })),
      pool.query('SELECT COUNT(*) as count FROM stripe.subscriptions').catch(() => ({ rows: [{ count: null }] })),
      pool.query('SELECT COUNT(*) as count FROM stripe.products').catch(() => ({ rows: [{ count: null }] })),
      pool.query('SELECT COUNT(*) as count FROM stripe.invoices').catch(() => ({ rows: [{ count: null }] })),
    ];

    const [customers, subscriptions, products, invoices] = await Promise.all(queries);

    return {
      customerCount: customers.rows[0]?.count !== null ? parseInt(customers.rows[0].count, 10) : null,
      subscriptionCount: subscriptions.rows[0]?.count !== null ? parseInt(subscriptions.rows[0].count, 10) : null,
      productCount: products.rows[0]?.count !== null ? parseInt(products.rows[0].count, 10) : null,
      invoiceCount: invoices.rows[0]?.count !== null ? parseInt(invoices.rows[0].count, 10) : null,
    };
  } catch {
    return null;
  } finally {
    await pool.end();
  }
}
