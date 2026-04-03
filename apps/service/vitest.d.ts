import 'vitest'

declare module 'vitest' {
  export interface ProvidedContext {
    temporalTestServerAddress: string
  }
}
