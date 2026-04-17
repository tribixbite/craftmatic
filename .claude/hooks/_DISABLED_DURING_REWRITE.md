# Hooks disabled during pipeline rearchitecture

The three `check-*-state.sh` hooks in this directory exit 0 early when this
file is present. They drove the old 7-category VLM grading loop, which is
being replaced by the new pipeline specified in:

  docs/superpowers/specs/2026-04-17-pipeline-rearchitecture-design.md

Chunk 10 (step 13 of the plan) replaces these hooks with a single
`check-pipeline-state.sh` keyed on the new `status` field.

Deleting this file re-activates the old behavior. Chunk 12 moves the hooks
to `_archived/` entirely and deletes the settings.json entries.
