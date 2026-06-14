#!/usr/bin/env bun
/**
 * Grade 600 Broadway generation against satellite + street view reference.
 * Usage: bun scripts/_grade-600b.ts <version> [--runs N]
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..');
const version = process.argv[2] || 'v4';
const runs = parseInt(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] ?? '3');

const apiKey = process.env.GOOGLE_API_KEY
  || (existsSync(resolve(ROOT, '.env'))
    ? readFileSync(resolve(ROOT, '.env'), 'utf8').match(/GOOGLE_API_KEY=(.+)/)?.[1]?.trim()
    : undefined);
if (!apiKey) { console.error('No GOOGLE_API_KEY'); process.exit(1); }

function toBase64(path: string): string {
  return readFileSync(path).toString('base64');
}

const satPath = resolve(ROOT, 'output/600broadway-satellite.jpg');
const svPath = resolve(ROOT, 'output/600broadway-streetview.jpg');
const isoPath = resolve(ROOT, `output/600broadway-${version}-iso.jpg`);
const tdPath = resolve(ROOT, `output/600broadway-${version}-td.jpg`);
const frontPath = resolve(ROOT, `output/600broadway-${version}-front.jpg`);
const hasFront = existsSync(frontPath);

for (const p of [satPath, svPath, isoPath, tdPath]) {
  if (!existsSync(p)) { console.error(`Missing: ${p}`); process.exit(1); }
}

const PROMPT = `You are rating how well a Minecraft voxel building matches a real building.

You are given ${hasFront ? 5 : 4} images:
1. Satellite photo of the real building (overhead view)
2. Street View photo of the real building (front facade)
3. Isometric render of the Minecraft voxel build
4. Top-down render of the Minecraft voxel build${hasFront ? '\n5. Front elevation render of the Minecraft voxel build (straight-on view of facade)' : ''}

Rate the Minecraft build on how accurately it recreates the real building. Consider:
- Footprint shape match (satellite vs top-down)
- Height / floor count match
- Wall material / color accuracy
- Roof shape match
- Architectural features (entrance, windows, balconies, trim, decorative elements)
- Overall proportions and massing
- Building type accuracy (residential/commercial/institutional)

Be honest and specific. This is a procedurally generated Minecraft building at ~1 block per meter, so expect blocky approximation, but the overall shape, proportions, materials, and distinctive features should match.

Respond in this exact JSON format:
{
  "footprint_score": <1-10>,
  "height_score": <1-10>,
  "material_score": <1-10>,
  "features_score": <1-10>,
  "proportions_score": <1-10>,
  "overall_score": <1-10>,
  "critique": "<2-3 sentences on what's wrong>",
  "suggestions": "<2-3 specific improvements>"
}`;

const parts: Array<Record<string, unknown>> = [
  { text: PROMPT },
  { inline_data: { mime_type: 'image/jpeg', data: toBase64(satPath) } },
  { inline_data: { mime_type: 'image/jpeg', data: toBase64(svPath) } },
  { inline_data: { mime_type: 'image/jpeg', data: toBase64(isoPath) } },
  { inline_data: { mime_type: 'image/jpeg', data: toBase64(tdPath) } },
];
if (hasFront) {
  parts.push({ inline_data: { mime_type: 'image/jpeg', data: toBase64(frontPath) } });
}

console.log(`Grading 600 Broadway ${version} (${runs} runs)...\n`);

const scores: number[] = [];
for (let i = 0; i < runs; i++) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 16384 },
        }),
      },
    );

    if (!res.ok) {
      console.error(`  Run ${i + 1}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      continue;
    }

    const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
    const text = (json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`  Run ${i + 1}: No JSON in response — ${text.slice(0, 300)}`);
      continue;
    }

    const result = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const overall = Number(result.overall_score) || 0;
    scores.push(overall);

    console.log(`  Run ${i + 1}/${runs}: Overall=${overall}/10`);
    console.log(`    Footprint=${result.footprint_score} Height=${result.height_score} Material=${result.material_score} Features=${result.features_score} Proportions=${result.proportions_score}`);
    console.log(`    Critique: ${result.critique}`);
    console.log(`    Suggestions: ${result.suggestions}`);
    console.log();
  } catch (err) {
    console.error(`  Run ${i + 1}: Error — ${err}`);
  }
  if (i < runs - 1) await Bun.sleep(5000);
}

if (scores.length > 0) {
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  console.log(`\n=== ${version}: Mean overall = ${mean.toFixed(1)}/10 (${scores.join(', ')}) ===`);
  if (mean >= 9) console.log('TARGET MET!');
  else console.log(`Need ${(9 - mean).toFixed(1)} more points to reach 9/10`);
}
