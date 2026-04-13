/** Bun-specific extensions not in @types/node */
interface ImportMeta {
  /** Absolute path of the directory containing the current module */
  readonly dir: string;
}
