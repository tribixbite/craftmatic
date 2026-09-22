/**
 * Shared types for the operator console: the inventory (cheat sheet) schema,
 * the selection model, and the run/job records the runner streams to the UI.
 *
 * The inventory is DATA (`inventory.ts`), not code: an operation declares its
 * runtime, its argument template and how its output is read, and the command
 * builder (`command.ts`) turns that into a real argv. Nothing here re-implements
 * what a script does — the console only spawns the script.
 */

/** Which interpreter runs the entry point. */
export type Runtime = 'bun' | 'node' | 'python' | 'bash';

/** Which checkout a command runs from. */
export type Cwd = 'craftmatic' | 'clego';

/**
 * What an operation takes per selected item.
 *  - `model`      an absolute path to a model file (from the index `path`, or a typed path)
 *  - `set`        a set number, e.g. `71043`
 *  - `index-path` a corpus path relative to `lego_sets/` (what clego tools key on)
 *  - `pack`       a built `.mcaddon`
 *  - `none`       the operation takes no item (a single run)
 */
export type InputKind = 'model' | 'set' | 'index-path' | 'pack' | 'none';

/**
 * How a batch is executed.
 *  - `per-item`     one process per selected item (parallelised by the queue)
 *  - `one-process`  one process for the whole selection (the script accepts many)
 */
export type BatchMode = 'per-item' | 'one-process';

/** How an option renders into argv. */
export type OptionRender =
  | 'eq'          // --key=value
  | 'space'       // --key value
  | 'switch'      // --key (boolean)
  | 'positional'  // value at the position of its `{opt}` token
  | 'env'         // exported as an environment variable, never in argv
  | 'repeat'      // --key=v1 --key=v2 … (";"-separated input)
  | 'list';       // --key v1 v2 v3 (whitespace-separated input; argparse nargs='*')

export interface OperationOption {
  /** Stable key, used in the run's option map and the export. */
  key: string;
  /** The flag as the script spells it (without dashes), or the env var name for `env`. */
  flag: string;
  render: OptionRender;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path';
  values?: readonly string[];
  default?: string | number | boolean;
  required?: boolean;
  /** When set (truthy), the script ignores its item list — an empty selection is allowed. */
  ignoresSelection?: boolean;
  help: string;
}

/** A token in the argv template. */
export type ArgToken =
  | string                       // literal
  | { item: true }               // the single item's argument (per-item mode)
  | { items: 'args' | 'csv' }    // all items: as separate args, or comma-joined
  | { itemsFile: true }          // a listing file written into the run dir, one item per line
  | { opt: string }              // an option (rendered per its `render`)
  | { runDir: string };          // a path under the run's own directory (`{runDir: 'board'}`)

/** How to read the numbers an operation prints. */
export type OutputParse =
  | { kind: 'json-last' }                          // the last JSON object on stdout
  | { kind: 'regex-lines'; pattern: string; groups: readonly string[] } // one capture per named column
  | { kind: 'none' };

export interface ResultColumn {
  key: string;
  label: string;
  /** Dot path into the parsed JSON (`a.b.c`, `arr.length`, `arr.0.x`), or a regex group name. */
  path: string;
}

export interface Evidence {
  /** JSON field holding the path the script wrote (after `json-last`). */
  fromJson?: string;
  /** Directory the script writes into, relative to its cwd, when the path is fixed. */
  dir?: string;
  /** The run's own directory holds the evidence (`--out {runDir}` style). */
  runDir?: boolean;
}

export type OperationGroup =
  | 'Pack export'
  | 'Pack validation'
  | 'Placement & accuracy grading'
  | 'Walk-through, vehicles & coasters'
  | 'Windows, parts & corpus checks'
  | 'Index & scoreboard'
  | 'Publishing (outward)'
  | 'Device (Pixel)'
  | 'Browser gates (dev server on :4000)'
  | 'Provenance & freshness';

export interface Operation {
  id: string;
  group: OperationGroup;
  title: string;
  /** The question a run of this answers. */
  answers: string;
  entry: string;          // path of the script relative to its cwd
  runtime: Runtime;
  cwd: Cwd;
  input: InputKind;
  /** Extensions the script can read, when `input` is `model` (lowercase, no dot). */
  accepts?: readonly string[];
  batch: BatchMode;
  /** For `set` input: the script wants the catalog spelling with revision (`10316-1`). */
  setRevision?: boolean;
  args: readonly ArgToken[];
  options: readonly OperationOption[];
  parse: OutputParse;
  columns: readonly ResultColumn[];
  evidence: Evidence;
  /** Rough wall time per item, from the docs or measured runs. */
  duration: string;
  /** Publishes, writes shared state, or touches the device: confirm in the UI, dry-run by default. */
  danger?: { why: string; dryRunOption?: string };
  /** Needs `bun dev:web` on :4000, a device serial, credentials, … */
  needs?: readonly string[];
  /** Where the project documents it. */
  docs?: readonly string[];
  /** Anything the operator should know before pressing run. */
  notes?: string;
}

/** One flattened row of the model index. */
export interface IndexRow {
  set: string;
  name: string;
  year: number;
  parts: number;
  src: string;
  path: string;
  tier: number;
  steps: number;
  n: number;
  hash: string;
  asm: 'verified' | 'defective' | 'unverified';
  sev: number;
  defects: readonly string[];
  variant: string | null;
  conv: boolean;
  /** Position within the set's `models[]` (0 = the auto-load pick). */
  rank: number;
}

/** The filter that produced a selection; stored with every run so it can be replayed. */
export interface IndexFilter {
  sets?: string;          // "71043 10294" or "710" (prefix) — space/comma separated
  name?: string;          // substring, case-insensitive
  text?: string;          // free text over set, name, path, src, defects, variant
  yearMin?: number;
  yearMax?: number;
  partsMin?: number;
  partsMax?: number;
  src?: readonly string[];
  asm?: 'any' | 'verified' | 'defective';
  sevMin?: number;
  sevMax?: number;
  tier?: 1 | 2 | 'any';
  primaryOnly?: boolean;  // models[0] of each set only
  hasDefect?: string;     // substring over the defects strings
  limit?: number;
}

/** A selected item, whatever its source (index, CSV, typed path, pack). */
export interface SelectionItem {
  /** Display id: set number, file stem, or pack name. */
  id: string;
  set?: string;
  indexPath?: string;   // relative to lego_sets
  model?: string;       // absolute model path
  pack?: string;        // absolute .mcaddon path
  label?: string;
}

export interface Selection {
  source: 'index' | 'csv' | 'text' | 'packs' | 'none';
  filter?: IndexFilter;
  /** The CSV/text as pasted, so a run can be replayed. */
  raw?: string;
  items: SelectionItem[];
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface Job {
  id: number;
  runId: string;
  item: SelectionItem | null;
  argv: string[];
  display: string;
  cwd: string;
  env: Record<string, string>;
  state: JobState;
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Parsed numbers per `columns` (json-last), or null when nothing parsed. */
  result: Record<string, unknown> | null;
  /** One row per matched line (regex-lines) — a one-process batch yields many. */
  rows: Record<string, string>[];
  evidence: string[];
  /** Why a job was skipped before spawning (e.g. wrong extension). */
  reason?: string;
  logFile: string;
}

export interface Run {
  id: string;
  opId: string;
  options: Record<string, string | number | boolean>;
  selection: Selection;
  concurrency: number;
  createdAt: number;
  dir: string;
  jobs: Job[];
  state: 'queued' | 'running' | 'done' | 'cancelled';
}

/** Server → UI event stream. */
export type ConsoleEvent =
  | { type: 'hello'; runs: Run[]; cpu: CpuSample }
  | { type: 'run'; run: Run }
  | { type: 'job'; runId: string; job: Job }
  | { type: 'log'; runId: string; jobId: number; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'cpu'; cpu: CpuSample };

export interface CpuSample {
  busy: number;     // 0..1 over the last interval
  cores: number;
  held: boolean;    // dispatch paused by the load guard
  at: number;
}
