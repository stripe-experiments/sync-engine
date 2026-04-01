export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
  state: Record<string, unknown>
}

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}
