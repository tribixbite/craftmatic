# QA Orchestrator Skill

Manages the craftmatic generator quality assessment pipeline. Survives context compaction by reading state from the tracking file.

## When to use
When the user says `/qa` or asks to continue quality assessment work.

## Instructions

1. **Read state file first**: Always read `/data/data/com.termux/files/home/git/craftmatic/output/qa-state.md` to understand current progress, scores, and which phase to resume.
2. **Execute the current phase**: The state file tracks which phase is active and which tasks within it are done.
3. **Update state after each task**: After completing any task, update `qa-state.md` with results before proceeding.
4. **Commit after each phase**: Make a conventional commit after completing each phase.
5. **Push and verify CI**: After pushing, always check CI with `gh run list` and `gh run watch`.
6. **Use bun/bunx**: Never use npm/npx.
7. **Re-score with Gemini**: Use `mcp__pal__chat` with model `gemini-3-pro-preview` and screenshots for scoring.
8. **Screenshot procedure**: Navigate to `https://tribixbite.github.io/craftmatic/`, click Gallery, resize to 1280x900, take top+bottom screenshots after scrolling `.gallery-grid`.

## Phases

### Phase 0: Gallery Curation (filter to 8+ scores)
### Phase 1: Generator Upgrades (target 9+ on all buildings)
### Phase 2: Re-score with Gemini (verify 9+ achieved)
### Phase 3: Room Interior Quality Test
### Phase 4: Multi-Style Matrix Test
### Phase 5: Scale Variation Test
### Phase 6: Seed Stability Test
### Phase 7: L/T/U Floor Plan Test
### Phase 8: Feature Flags Test
### Phase 9: Final Report

## Key files
- State: `output/qa-state.md`
- Generator: `src/gen/generator.ts`
- Structures: `src/gen/structures.ts`
- Styles: `src/gen/styles.ts`
- Gallery: `web/src/ui/gallery.ts`
- Types: `src/types/index.ts`
