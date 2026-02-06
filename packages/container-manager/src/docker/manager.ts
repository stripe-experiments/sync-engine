import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as net from 'net';
import { fileURLToPath } from 'url';
import type { ContainerInfo, ContainerConfig } from '../types.js';

const execAsync = promisify(exec);

// Get current file directory (ESM compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the docker compose directory
const COMPOSE_DIR = path.resolve(__dirname, '../../../../docker/supabase');

// Store container metadata
const METADATA_FILE = path.join(
  process.env.HOME || '~',
  '.stripe-sync-containers.json'
);

interface ContainerMetadata {
  id: string;
  name: string;
  stripeApiKey: string;
  port: number;
  dbPort: number;
  createdAt: string;
  projectName: string;
}

export class DockerManager {
  private docker: Docker;
  private containers: Map<string, ContainerMetadata> = new Map();

  constructor() {
    this.docker = new Docker();
  }

  async initialize(): Promise<void> {
    await this.loadMetadata();
  }

  private async loadMetadata(): Promise<void> {
    try {
      const data = await fs.readFile(METADATA_FILE, 'utf-8');
      const metadata: ContainerMetadata[] = JSON.parse(data);
      this.containers = new Map(metadata.map((c) => [c.id, c]));
    } catch {
      // File doesn't exist or is invalid, start fresh
      this.containers = new Map();
    }
  }

  private async saveMetadata(): Promise<void> {
    const metadata = Array.from(this.containers.values());
    await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
  }

  private generateProjectName(): string {
    const randomId = crypto.randomBytes(4).toString('hex');
    return `stripe-sync-${randomId}`;
  }

  /**
   * Generate a deterministic username based on the Stripe API key
   * This ensures the same key always gets the same username
   */
  generateDeterministicUsername(stripeApiKey: string): string {
    const hash = crypto.createHash('sha256').update(`username:${stripeApiKey}`).digest('hex');
    // Use first 12 characters prefixed with 'user_' for a readable username
    return `user_${hash.substring(0, 12)}`;
  }

  /**
   * Generate a deterministic password based on the Stripe API key
   * This ensures the same key always gets the same password
   */
  generateDeterministicPassword(stripeApiKey: string): string {
    const hash = crypto.createHash('sha256').update(`password:${stripeApiKey}`).digest('hex');
    // Use first 32 characters for a secure password
    return hash.substring(0, 32);
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port, '0.0.0.0');
    });
  }

  private async findAvailablePort(basePort: number = 8000): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.containers.values()).map((c) => c.port)
    );
    let port = basePort;
    
    // Check all derived ports: base (Kong HTTP), base+443 (Kong HTTPS), base+543 (Pooler)
    const checkAllPorts = async (p: number): Promise<boolean> => {
      const portsToCheck = [p, p + 443, p + 543];
      for (const portToCheck of portsToCheck) {
        if (!(await this.isPortAvailable(portToCheck))) {
          return false;
        }
      }
      return true;
    };
    
    while (usedPorts.has(port) || !(await checkAllPorts(port))) {
      port += 1000; // Increment by 1000 to ensure no overlap with derived ports
    }
    return port;
  }

  private async findAvailableDbPort(basePort: number = 54322): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.containers.values()).map((c) => c.dbPort).filter(Boolean)
    );
    let port = basePort;
    while (usedPorts.has(port) || !(await this.isPortAvailable(port))) {
      port += 1;
    }
    return port;
  }

  /**
   * Check if a container with this Stripe API key already exists
   */
  hasContainerForStripeKey(stripeApiKey: string): boolean {
    for (const metadata of this.containers.values()) {
      if (metadata.stripeApiKey === stripeApiKey) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the container info for a given Stripe API key
   */
  getContainerByStripeKey(stripeApiKey: string): ContainerMetadata | null {
    for (const metadata of this.containers.values()) {
      if (metadata.stripeApiKey === stripeApiKey) {
        return metadata;
      }
    }
    return null;
  }

  async spawnContainer(config: ContainerConfig): Promise<ContainerInfo> {
    // Check if a container with this Stripe key already exists
    const existing = this.getContainerByStripeKey(config.stripeApiKey);
    if (existing) {
      return {
        id: existing.id,
        name: existing.name,
        stripeApiKey: existing.stripeApiKey,
        status: 'error',
        createdAt: new Date(existing.createdAt),
        port: existing.port,
        customerCount: null,
        error: `Container "${existing.name}" already exists for this Stripe API key`,
      };
    }

    const projectName = config.name || this.generateProjectName();
    const port = config.port || (await this.findAvailablePort());
    const dbPort = await this.findAvailableDbPort();

    // Generate a unique ID for this container
    const id = crypto.randomBytes(8).toString('hex');

    // Create a temporary .env file with the Stripe API key and custom ports
    const envPath = path.join(COMPOSE_DIR, `.env.${projectName}`);
    const envExamplePath = path.join(COMPOSE_DIR, '.env.example');

    // Read the example env and modify it
    let envContent = await fs.readFile(envExamplePath, 'utf-8');

    // Add STRIPE_SECRET_KEY and DB_EXTERNAL_PORT
    envContent += `\n# Stripe Configuration\nSTRIPE_SECRET_KEY=${config.stripeApiKey}\n`;
    envContent += `\n# External DB port for this instance\nDB_EXTERNAL_PORT=${dbPort}\n`;

    // Update ports to use the unique port
    envContent = envContent.replace(/KONG_HTTP_PORT=\d+/, `KONG_HTTP_PORT=${port}`);
    envContent = envContent.replace(
      /KONG_HTTPS_PORT=\d+/,
      `KONG_HTTPS_PORT=${port + 443}`
    );
    envContent = envContent.replace(
      /POOLER_PROXY_PORT_TRANSACTION=\d+/,
      `POOLER_PROXY_PORT_TRANSACTION=${port + 543}`
    );

    // Read dashboard credentials from the main .env file
    const mainEnvPath = path.join(COMPOSE_DIR, '.env');
    let dashboardUsername = 'supabase';
    let dashboardPassword = 'supabase';
    try {
      const mainEnvContent = await fs.readFile(mainEnvPath, 'utf-8');
      const usernameMatch = mainEnvContent.match(/DASHBOARD_USERNAME=(.+)/);
      const passwordMatch = mainEnvContent.match(/DASHBOARD_PASSWORD=(.+)/);
      if (usernameMatch) dashboardUsername = usernameMatch[1].trim();
      if (passwordMatch) dashboardPassword = passwordMatch[1].trim();
    } catch {
      // Use defaults if .env doesn't exist
    }

    // Generate unique secrets for this instance
    const jwtSecret = crypto.randomBytes(32).toString('base64');
    // Generate deterministic password based on Stripe API key (so same key always gets same password)
    const postgresPassword = this.generateDeterministicPassword(config.stripeApiKey);
    const secretKeyBase = crypto.randomBytes(32).toString('base64');
    const vaultEncKey = crypto.randomBytes(16).toString('hex');
    const pgMetaCryptoKey = crypto.randomBytes(16).toString('hex');
    const poolerTenantId = crypto.randomBytes(8).toString('hex');

    // Set dashboard username and password from main .env
    envContent = envContent.replace(
      /DASHBOARD_USERNAME=.*/,
      `DASHBOARD_USERNAME=${dashboardUsername}`
    );
    envContent = envContent.replace(
      /DASHBOARD_PASSWORD=.*/,
      `DASHBOARD_PASSWORD=${dashboardPassword}`
    );

    envContent = envContent.replace(
      /JWT_SECRET=.*/,
      `JWT_SECRET=${jwtSecret}`
    );
    envContent = envContent.replace(
      /POSTGRES_PASSWORD=.*/,
      `POSTGRES_PASSWORD=${postgresPassword}`
    );
    envContent = envContent.replace(
      /SECRET_KEY_BASE=.*/,
      `SECRET_KEY_BASE=${secretKeyBase}`
    );
    envContent = envContent.replace(
      /VAULT_ENC_KEY=.*/,
      `VAULT_ENC_KEY=${vaultEncKey}`
    );
    envContent = envContent.replace(
      /PG_META_CRYPTO_KEY=.*/,
      `PG_META_CRYPTO_KEY=${pgMetaCryptoKey}`
    );
    envContent = envContent.replace(
      /POOLER_TENANT_ID=.*/,
      `POOLER_TENANT_ID=${poolerTenantId}`
    );

    await fs.writeFile(envPath, envContent);

    const metadata: ContainerMetadata = {
      id,
      name: projectName,
      stripeApiKey: config.stripeApiKey,
      port,
      dbPort,
      createdAt: new Date().toISOString(),
      projectName,
    };

    this.containers.set(id, metadata);
    await this.saveMetadata();

    // Start the containers using docker compose with the multi-instance compose files
    // Uses both the base multi.yml and the installer.multi.yml to run migrations
    const composeFile = path.join(COMPOSE_DIR, 'docker-compose.multi.yml');
    const installerComposeFile = path.join(COMPOSE_DIR, 'docker-compose.installer.multi.yml');
    try {
      await execAsync(
        `docker compose -p ${projectName} -f ${composeFile} -f ${installerComposeFile} --env-file ${envPath} up -d`,
        { cwd: COMPOSE_DIR }
      );

      return {
        id,
        name: projectName,
        stripeApiKey: config.stripeApiKey,
        status: 'running',
        createdAt: new Date(),
        port,
        customerCount: null,
      };
    } catch (error) {
      // Clean up on failure
      this.containers.delete(id);
      await this.saveMetadata();
      await fs.unlink(envPath).catch(() => {});

      return {
        id,
        name: projectName,
        stripeApiKey: config.stripeApiKey,
        status: 'error',
        createdAt: new Date(),
        port,
        customerCount: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const result: ContainerInfo[] = [];

    for (const [id, metadata] of this.containers) {
      const status = await this.getContainerStatus(metadata.projectName);
      result.push({
        id,
        name: metadata.name,
        stripeApiKey: metadata.stripeApiKey,
        status,
        createdAt: new Date(metadata.createdAt),
        port: metadata.port,
        customerCount: null, // Will be filled by the UI
      });
    }

    return result;
  }

  private async getContainerStatus(
    projectName: string
  ): Promise<'running' | 'stopped' | 'creating' | 'error'> {
    const composeFile = path.join(COMPOSE_DIR, 'docker-compose.multi.yml');
    const installerComposeFile = path.join(COMPOSE_DIR, 'docker-compose.installer.multi.yml');
    try {
      const { stdout } = await execAsync(
        `docker compose -p ${projectName} -f ${composeFile} -f ${installerComposeFile} ps --format json`,
        { cwd: COMPOSE_DIR }
      );

      if (!stdout.trim()) {
        return 'stopped';
      }

      const lines = stdout.trim().split('\n');
      const containers = lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);

      if (containers.length === 0) {
        return 'stopped';
      }

      const allRunning = containers.every(
        (c: { State?: string }) => c.State === 'running'
      );
      const anyRunning = containers.some(
        (c: { State?: string }) => c.State === 'running'
      );

      if (allRunning) return 'running';
      if (anyRunning) return 'creating';
      return 'stopped';
    } catch {
      return 'error';
    }
  }

  async stopContainer(id: string): Promise<void> {
    const metadata = this.containers.get(id);
    if (!metadata) {
      throw new Error(`Container ${id} not found`);
    }

    const composeFile = path.join(COMPOSE_DIR, 'docker-compose.multi.yml');
    const installerComposeFile = path.join(COMPOSE_DIR, 'docker-compose.installer.multi.yml');
    const envPath = path.join(COMPOSE_DIR, `.env.${metadata.projectName}`);
    await execAsync(
      `docker compose -p ${metadata.projectName} -f ${composeFile} -f ${installerComposeFile} --env-file ${envPath} stop`,
      { cwd: COMPOSE_DIR }
    );
  }

  async startContainer(id: string): Promise<void> {
    const metadata = this.containers.get(id);
    if (!metadata) {
      throw new Error(`Container ${id} not found`);
    }

    const composeFile = path.join(COMPOSE_DIR, 'docker-compose.multi.yml');
    const installerComposeFile = path.join(COMPOSE_DIR, 'docker-compose.installer.multi.yml');
    const envPath = path.join(COMPOSE_DIR, `.env.${metadata.projectName}`);
    await execAsync(
      `docker compose -p ${metadata.projectName} -f ${composeFile} -f ${installerComposeFile} --env-file ${envPath} start`,
      { cwd: COMPOSE_DIR }
    );
  }

  async deleteContainer(id: string): Promise<void> {
    const metadata = this.containers.get(id);
    if (!metadata) {
      throw new Error(`Container ${id} not found`);
    }

    const composeFile = path.join(COMPOSE_DIR, 'docker-compose.multi.yml');
    const installerComposeFile = path.join(COMPOSE_DIR, 'docker-compose.installer.multi.yml');
    const envPath = path.join(COMPOSE_DIR, `.env.${metadata.projectName}`);

    // Stop and remove containers, networks, and volumes
    await execAsync(
      `docker compose -p ${metadata.projectName} -f ${composeFile} -f ${installerComposeFile} --env-file ${envPath} down -v --remove-orphans`,
      { cwd: COMPOSE_DIR }
    );

    // Clean up env file
    await fs.unlink(envPath).catch(() => {});

    // Remove from metadata
    this.containers.delete(id);
    await this.saveMetadata();
  }

  getContainerDbConfig(id: string): {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  } | null {
    const metadata = this.containers.get(id);
    if (!metadata) {
      return null;
    }

    // The database is accessible on the host via the exposed port
    return {
      host: 'localhost',
      port: metadata.dbPort || 54322,
      user: 'postgres',
      password: '', // Will be read from env file
      database: 'postgres',
    };
  }

  /**
   * Get the DB port for a container by name
   */
  getDbPort(projectName: string): number | null {
    for (const metadata of this.containers.values()) {
      if (metadata.projectName === projectName || metadata.name === projectName) {
        return metadata.dbPort || 54322;
      }
    }
    return null;
  }

  /**
   * Get the full database URL with credentials for a given Stripe API key
   * Format: postgresql://postgres:password@host:port/database
   * Uses 'postgres' as the username (default superuser) with deterministic password
   */
  getDatabaseUrl(stripeApiKey: string, host: string = 'localhost'): string | null {
    const metadata = this.getContainerByStripeKey(stripeApiKey);
    if (!metadata) {
      return null;
    }

    const username = 'postgres';
    const password = this.generateDeterministicPassword(stripeApiKey);
    const port = metadata.dbPort || 54322;
    const database = 'postgres';

    return `postgresql://${username}:${password}@${host}:${port}/${database}`;
  }

  /**
   * Delete a container by Stripe API key
   */
  async deleteContainerByStripeKey(stripeApiKey: string): Promise<void> {
    const metadata = this.getContainerByStripeKey(stripeApiKey);
    if (!metadata) {
      throw new Error('No container found for this Stripe API key');
    }

    await this.deleteContainer(metadata.id);
  }
}
