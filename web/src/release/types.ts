/**
 * Release-identity types (X-01, BIZ-52; plan D section 3.2).
 *
 * Pure data shapes: nothing here touches disk, the network or the clock. The
 * registry (`release/products/<id>.json`) and the ledger
 * (`release/identity-ledger.json`) are JSON files that deserialise into these.
 */

/** A semantic version. Bedrock manifests take [major, minor, patch]; no pre-release tag ever reaches a manifest. */
export interface SemVer { major: number; minor: number; patch: number }

/** The five manifest uuids of one product (behaviour pack header, data and script modules; resource pack header and resources). */
export interface ProductUuids {
  bpHeader: string; bpData: string; bpScript: string; rpHeader: string; rpResources: string;
}

/** Frozen per-product Bedrock identity, minted ONCE by `release.ts init-product`, never derived from a label. */
export interface ProductIdentity {
  /**
   * The namespace for every id in the add-on (`<creator>_<pack>` per plan A 1.3).
   * Null until the user decides the brand (U1): a release build refuses null.
   */
  namespace: string | null;
  /** Folder prefix inside the .mcaddon. Frozen with the uuids. */
  folderStem: string;
  uuids: ProductUuids;
}

/** One product = one CurseForge project = one itch page = one catalog card. */
export interface ProductRecord {
  id: string;
  /** Player-facing name. */
  displayName: string;
  /** D ships only 'free'; A owns 'paid-marketplace'. */
  tier: 'free' | 'paid-marketplace';
  identity: ProductIdentity;
  /**
   * Names of fields that still hold a stand-in value because the user has not
   * decided them (U1: brand/namespace/publisher). Data, not code: the release
   * flow (D-08) can refuse while this is non-empty.
   */
  placeholders: string[];
  /** A's design ids (with provenance logs) that the pack contains. */
  designs: Array<{ designId: string; role: 'vehicle' | 'door-kit' | 'seat-kit' | 'landmark' | 'ride' | 'prop' }>;
  /** Pinned inputs that make a build reproducible. */
  toolchain: {
    /** Exact `bun --version` at mint time. */
    bun: string;
    /** sha256 of bun.lock at mint time. */
    lockfileSha256: string;
    /** Official LDraw archive. `sha256` is null until X-04 / D-08 pins the real archive. */
    ldrawLibrary: { archive: 'complete.zip'; sha256: string | null; root: string };
    scriptModules: { server: string; serverUi: string };
    minEngineVersion: [number, number, number];
  };
  /** Released versions, newest last; mirrors identity-ledger.json. */
  versions: ReleasedVersion[];
  /** Usage guidelines want a name and a non-chat contact (U1). */
  publisher: { name: string; contactEmail: string } | null;
}

export interface ReleasedVersion {
  version: SemVer;
  /** Full sha the bytes were built from. */
  commit: string;
  /** `<product>-v<semver>`, set when the user tags (finalize). */
  tag: string | null;
  /** Commit time; drives every clock in the build. */
  sourceDateEpoch: number;
  artifacts: Array<{ file: string; sha256: string; bytes: number }>;
  /** Device-round id that played THIS sha256 (required at finalize). */
  deviceEvidence: string | null;
}

/** One appended line of the identity ledger: what a released version froze. */
export interface IdentityLedgerEntry {
  product: string;
  /** `major.minor.patch`. */
  version: string;
  namespace: string;
  uuids: ProductUuids;
  entityIds: string[];
  blockIds: string[];
  itemIds: string[];
  /** file name -> sha256 hex. */
  sha256: Record<string, string>;
}

/** A dev build's identity: separate uuids and a labelled name so it never shadows a release. */
export interface DevIdentity {
  identity: ProductIdentity;
  displayName: string;
}

/** The identity a release build of a given version must use. */
export interface ReleaseBuildIdentity {
  version: SemVer;
  identity: ProductIdentity & { namespace: string };
}
