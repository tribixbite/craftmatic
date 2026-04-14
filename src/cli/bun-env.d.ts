/** Bun-specific extensions not in @types/node */
interface ImportMeta {
  /** Absolute path of the directory containing the current module */
  readonly dir: string;
}

/** Minimal Bun global API surface used by CLI modules */
declare namespace Bun {
  /** Returns a lazy file reference that can be read on demand */
  function file(path: string): {
    text(): Promise<string>;
    exists(): Promise<boolean>;
    arrayBuffer(): Promise<ArrayBuffer>;
    readonly size: number;
  };
  /** Write data to a file path */
  function write(path: string, data: Uint8Array | string | ArrayBuffer): Promise<number>;
}
