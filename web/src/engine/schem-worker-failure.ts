const PIPELINE_ERROR = Symbol('schemPipelineError');

type PipelineWorkerError = Error & { [PIPELINE_ERROR]?: true };

/** Mark a pipeline error reported by a healthy worker; rerunning it inline cannot repair it. */
export function pipelineWorkerError(message: string): Error {
  const error = new Error(message) as PipelineWorkerError;
  error[PIPELINE_ERROR] = true;
  return error;
}

/** Inline fallback is reserved for worker construction or transport failures. */
export function shouldRetryWorkerInline(error: unknown): boolean {
  return !(error instanceof Error && (error as PipelineWorkerError)[PIPELINE_ERROR]);
}
