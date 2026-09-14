#!/usr/bin/env bun

// From ldraw-part-dims.ts:
// const P = (w: number, l: number): Dims => [w, 1, l];
// So P(1,1) = [1, 1, 1]

const P = (w: number, l: number): [number, number, number] => [w, 1, l];
console.log('P(1, 1) =', P(1, 1));
console.log('P(2, 2) =', P(2, 2));
console.log('P(1, 2) =', P(1, 2));
