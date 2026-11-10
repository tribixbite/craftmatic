/** The mapping between massing metres and lattice cells (A07/A08, BIZ-05). */
export interface Frame {
  /** Studs per metre and plates per metre of the massing's scale. */
  spm: number;
  ppm: number;
  /** Studs of margin added on every side of the massing's box. */
  pad: number;
  /** Plate layers of the base plate. */
  basePlates: number;
}

/** Stud column holding massing coordinate `m` (metres, x or z). */
export const cellOf = (f: Frame, m: number): number => Math.floor(m * f.spm + 1e-6) + f.pad;
/** Plate layer holding height `y` metres above the model's zero. */
export const plateOf = (f: Frame, y: number): number => Math.floor(y * f.ppm + 1e-6) + f.basePlates;
