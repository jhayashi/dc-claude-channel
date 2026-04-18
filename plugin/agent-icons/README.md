# Agent badge glyphs

Vendored Lucide line icons (ISC licensed) used by the runtime badge renderer
in `plugin/agent-icon-render.ts`.

## Adding a new glyph

1. Drop the SVG here as `<name>.svg` (use the upstream Lucide name verbatim).
   Source: https://github.com/lucide-icons/lucide/tree/main/icons
2. Add the name to the relevant archetype array in
   `plugin/agent-icons/palettes.ts`.
3. Restart the dispatcher. No other code changes needed.

The renderer extracts the inner shape XML and re-skins it with badge ink
and stroke width — the SVG's own width, height, stroke, and stroke-width
attributes are ignored.
