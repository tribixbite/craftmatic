import type { FeatureSet, Massing } from '../types.js';
import type { Canvas } from './canvas.js';
import type { Frame } from './frame.js';
import type { Mask } from './footprint.js';
import type { StyleKey } from './rules.js';

export interface FacadeStats { openings: number; relief: number; skipped: number; byKind: Record<string, number> }
export interface FacadeContext { canvas: Canvas; frame: Frame; massing: Massing; features: FeatureSet; masks: Map<string, Mask>; colours: { wall: number; trim: number; roof: number; base: number }; style: StyleKey; notes: string[] }
export function applyFeatures(_ctx: FacadeContext): FacadeStats { return { openings: 0, relief: 0, skipped: 0, byKind: {} }; }
