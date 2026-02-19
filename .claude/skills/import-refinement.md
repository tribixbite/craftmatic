# Import Pipeline Refinement Skill

Maintains the address-to-structure import pipeline.

## When to use
When the user asks to improve import accuracy, add data sources, fix property data conversion, debug pipeline issues, or modify CLI address generation.

## Key Files
- Pipeline logic: `src/gen/address-pipeline.ts` (PropertyData, convertToGenerationOptions, resolveStyle, inferFeatures, estimateStoriesFromFootprint)
- Node API clients: `src/gen/api/{geocoder,parcl,osm}.ts`
- Web API clients: `web/src/ui/import-{geocoder,parcl,osm,rentcast,streetview,mapbox}.ts`
- Web UI orchestrator: `web/src/ui/import.ts` (populateFromParcl, populateFromOSM, doGenerate)
- CLI integration: `src/cli.ts` (genFromAddress)
- Types: `src/types/index.ts` (GenerationOptions, FeatureFlags, StyleName)
- npm exports: `src/index.ts`
- Tests: `test/parcl-osm-pipeline.test.ts`, `test/generation-automation.test.ts`
- Spec: `docs/specs/import-pipeline.md`

## Priority Chains

These are the established priority chains — maintain ordering when adding new sources:

1. **Style**: user > OSM architecture > RentCast architecture > city > county > year
2. **Dimensions**: CLI override > OSM footprint > sqft estimate (clamped 10-60)
3. **Stories**: RentCast floorCount > OSM levels > footprint calc > heuristic > default (2)
4. **Wall material**: RentCast exterior > OSM material > satellite color > style default

## Architecture Rules

- `src/gen/address-pipeline.ts` must NOT import from `web/src/ui/` — it's the shared module used by both CLI and web
- `src/gen/api/*.ts` must NOT use browser APIs (localStorage, DOM) — use process.env for config
- `web/src/ui/import.ts` imports from `@craft/gen/address-pipeline.js` and re-exports convertToGenerationOptions + PropertyData
- Test files can import from both `@craft/` and `@ui/` via vitest path aliases

## Testing

- `node node_modules/.bin/vitest run` (Android workaround for bun CouldntReadCurrentDirectory bug)
- Pipeline integration tests in `test/parcl-osm-pipeline.test.ts` require `PARCL_API_KEY` env var
- Conversion unit tests in `test/generation-automation.test.ts` test pure functions (no API calls)

## Common Tasks

### Adding a new data source
1. Create web client in `web/src/ui/import-{source}.ts` (browser-compatible)
2. Create Node client in `src/gen/api/{source}.ts` (Bun/Node-compatible)
3. Add fields to PropertyData interface in `src/gen/address-pipeline.ts`
4. Wire into `convertToGenerationOptions` with appropriate priority
5. Update `web/src/ui/import.ts` to call the web client and populate form fields
6. Update `src/cli.ts` `genFromAddress()` to call the Node client
7. Export from `src/index.ts`
8. Add tests, update docs/specs/import-pipeline.md

### Fixing an accuracy issue
1. Identify the priority chain involved (style, dimensions, stories, or wall)
2. Modify the relevant function in `src/gen/address-pipeline.ts`
3. If web-specific (form fields), also update `web/src/ui/import.ts`
4. Add a test case in `test/generation-automation.test.ts`
5. Verify with `bunx tsx src/cli.ts gen -a "address"` on a real property
