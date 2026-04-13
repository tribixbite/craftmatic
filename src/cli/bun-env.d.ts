/** Bun-specific extensions not in @types/node */
interface ImportMeta {
  /** Absolute path of the directory containing the current module */
  readonly dir: string;
}

/** Minimal Bun global API surface used by CLI modules */
declare namespace Bun {
  /** Returns a lazy file reference that can be read on demand */
  function file(path: string): { text(): Promise<string>; exists(): Promise<boolean> };
}
