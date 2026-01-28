import type { SigmaIngestionConfig } from './sigmaIngestion'
import { SIGMA_INGESTION_CONFIGS as AUTO_GENERATED_SIGMA_INGESTION_CONFIGS } from './schema/artifacts/sigmaIngestionConfigs'

type SigmaColumnMetadata = { primaryKey?: boolean }
type SigmaConfigWithColumns = SigmaIngestionConfig & { columns?: SigmaColumnMetadata[] }

const isConnectedAccountVariant = (
  name: string,
  config: SigmaIngestionConfig
): boolean =>
  [name, config.sigmaTable, config.destinationTable].some((value) =>
    value.includes('connected_account_')
  )

const hasPrimaryKey = (config: SigmaIngestionConfig): boolean => {
  const columns = (config as SigmaConfigWithColumns).columns
  return Array.isArray(columns) && columns.some((column) => column.primaryKey)
}

const hasColumnMetadata = (config: SigmaIngestionConfig): boolean => {
  const columns = (config as SigmaConfigWithColumns).columns
  return Array.isArray(columns) && columns.length > 0
}

const filterSigmaIngestionConfigs = (
  configs: Record<string, SigmaIngestionConfig>
): Record<string, SigmaIngestionConfig> =>
  Object.fromEntries(
    Object.entries(configs).filter(
      ([name, config]) =>
        !isConnectedAccountVariant(name, config) &&
        hasColumnMetadata(config) &&
        hasPrimaryKey(config)
    )
  )

const MANUAL_SIGMA_INGESTION_CONFIGS: Record<string, SigmaIngestionConfig> = {
  // Add any manual overrides here
  // Example:
  // 'my_table': {
  //   sigmaTable: 'my_table',
  //   destinationTable: 'my_table',
  //   pageSize: 10000,
  //   cursor: {
  //     version: 1,
  //     columns: [{ column: 'id', type: 'string' }],
  //   },
  // },
}

export const SIGMA_INGESTION_CONFIGS: Record<string, SigmaIngestionConfig> =
  filterSigmaIngestionConfigs({
    ...AUTO_GENERATED_SIGMA_INGESTION_CONFIGS,
    ...MANUAL_SIGMA_INGESTION_CONFIGS,
  })
