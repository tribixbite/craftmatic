export type LiveModel = { title: string; w: number; h: number; l: number; palette: [string, Record<string, string | number | boolean>][]; ops: number[][]; blocks?: number; samples?: number[] };
export function checksum(text: string): string;
export function encodeModel(model: LiveModel): string;
export function decodeModel(encoded: string): LiveModel;
export function makeParts(encoded: string, size?: number): string[];
export function acceptPart(session: unknown, input: string, deferDecode?: boolean): {session: unknown; model?: LiveModel; encoded?: string};
