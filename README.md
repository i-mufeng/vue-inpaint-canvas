# vue-inpaint-canvas

> Framework-agnostic core + Vue 3 component for **inpaint mask painting**, cropping and light adjustments — purpose-built for AI image editing (gpt-image / Stable Diffusion inpainting).

Paints a **transparent-alpha PNG mask** following the OpenAI `images/edits` convention (painted area → `alpha=0` = repaint). Ships its own Konva-based engine; **no `vue-konva`, single runtime dependency (`konva`)**, theme fully host-injected.

## Status

Early but tested. The **mask pipeline** — brush / eraser / **rect-select** (opt-in via `tools`) / clear / invert-alpha PNG export — is implemented with **automated pixel-level tests** (alpha inversion for both polarities, size, coverage, binarization stability). **Geometry (crop / rotate 90° / horizontal·vertical flip) is implemented** with full **mask↔geometry coordinate linkage** (vector "method A": image and mask share one layer transform, mask nodes keep source-space coords, so export size = transformed canvas and `image.width === mask.width === result.width`), a **unified command undo/redo stack** (mask strokes + geometry on one history), and an **interactive crop overlay** (ratio presets via `cropRatios`, dimmed mask, drag-to-select, composes with existing crops) — verified by 264 tests on jsdom + node-canvas (real pixels) plus browser regression. i18n (`locale`), brush cursor, tool gating and accessibility (`aria-label` / `aria-pressed` / reduced-motion) are wired. Feathering and zoom/pan are still scaffolded (`feather` is a **no-op**, 0.3); crop resize-handles are a follow-up polish. Adjustments (brightness / contrast / saturation) are wired in the **core API only** (`engine.setAdjust`) — no component UI yet (0.3). See [DESIGN.md](./DESIGN.md) for the full spec and roadmap.

> **Note:** a `string` source URL is loaded with `crossOrigin="anonymous"`; the host must serve it with CORS allowing anonymous, otherwise the canvas is tainted and export throws `SecurityError`. Pass a `Blob`/`File` to avoid this.

## Install

```bash
bun add vue-inpaint-canvas konva
```

`vue` (^3.5) is a peer dependency.

## Usage — Vue

```vue
<script setup lang="ts">
import { ImageStudio } from "vue-inpaint-canvas";
import "vue-inpaint-canvas/style.css";
import type { StudioResult } from "vue-inpaint-canvas";

function onApply(r: StudioResult) {
  // r.image : processed source image (Blob)
  // r.mask  : transparent-alpha inpaint mask (Blob | null)
  // upload both to your AI backend's images/edits endpoint
}
</script>

<template>
  <ImageStudio :source="file" @apply="onApply" />
</template>
```

## Usage — framework-agnostic core

```ts
import { StudioEngine } from "vue-inpaint-canvas/core";

const engine = new StudioEngine(containerEl);
await engine.loadSource(file);
engine.setTool("brush");
const { image, mask } = await engine.exportResult();
```

## Theming

Override the `--vic-*` CSS variables, or pass a `:theme` object, to match your design system. The library ships a neutral dark default and never hard-codes a business theme.

## Develop

```bash
bun install
bun run dev        # playground (vite)
bun run build      # build library → dist/
bun run test       # vitest
bun run typecheck  # vue-tsc
bun run lint       # oxlint
```

## Design notes

- **`mask` semantics are inverted on purpose.** What the user paints (intent: "change here") becomes `alpha=0` (transparent) in the exported PNG, per OpenAI/BananaRouter `images/edits`. See [DESIGN.md](./DESIGN.md) §1.
- **The library does no network / business logic.** It takes a `source` and emits a `StudioResult`. Gating (which models support masks), credits, and uploads belong to the host app.

## License

MIT
