export const REDACT_PATHS = [
  // Auth & credentials
  '*.api_key',
  '*.apiKey',
  '*.secret',
  '*.secret_key',
  '*.secretKey',
  '*.token',
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
  '*.refreshToken',
  '*.password',
  '*.authorization',
  '*.webhook_secret',
  '*.webhookSecret',

  // Connection & infrastructure
  '*.connection_string',
  '*.connectionString',
  '*.database_url',
  '*.databaseUrl',

  // Synced data — never log business data flowing through the pipeline
  '*.data',
  '*.record.data',
  '*.request_body',
  '*.requestBody',
  '*.response_body',
  '*.responseBody',
]

export const REDACT_CENSOR = '[REDACTED]'
