# COAST Draw: polished mini-app controls and motion

This increment refines the hosted Photon Draw mini-app while preserving the repaired custom 1024×1024 canvas, existing provider modes, streaming, revisions, refinement, Save, and Animate flows.

- Remove the header prompt/status treatment and center a segmented Sketch/Preview crossfade toggle.
- Replace the four text-heavy model controls with accessible local SVG icon buttons and a fixed selected-model caption.
- Preserve touch capture, safe-area sizing, the three-row layout, Toolcraft-inspired controls, and the licensed tldraw gate.
- Add adaptive, client-only React Bits-inspired GhostFibers background and a temporary GlowCursor pencil trail. Decorative effects are pointer-transparent, pause for reduced motion and active editing, and never enter raster exports.
- Polling and snapshot restoration preserve an explicit user view choice; only a newly decoded genuine preview may auto-open Preview.

## Validation

Verify compact iPhone, expanded iPhone, iPad, desktop, reduced-motion, delayed-media, failed-WebGL, touch drawing, model selection, streaming Preview, refinement, and Save behavior. Run `pnpm check` and the Draw browser regressions before deploying to `5dee-studios/mayor`.
