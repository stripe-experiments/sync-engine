export interface ContainerInfo {
  id: string;
  name: string;
  stripeApiKey: string;
  status: 'running' | 'stopped' | 'creating' | 'error';
  createdAt: Date;
  port: number;
  customerCount: number | null;
  error?: string;
}

export interface ContainerConfig {
  stripeApiKey: string;
  name?: string;
  port?: number;
}

export interface ContainerState {
  containers: ContainerInfo[];
  selectedIndex: number;
  loading: boolean;
  message: string | null;
}

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
