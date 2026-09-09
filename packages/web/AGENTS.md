# Web package rules

## Dependency direction

- Keep `src/chat` and `src/components/ui` controlled and presentation-only.
- Never import gallery modules, pico packages, Effect, atoms, RPC, or router APIs from production components.
- Add live application state through one route adapter. Map records into `chat-model.ts` types before rendering.
- Import concrete files directly. Do not add barrel files.

## Components

- Keep transcript items ordered. Tool activity may split two assistant segments.
- Keep all component props serializable display values and callbacks. Do not pass transport records or errors.
- Keep app-shell state out of production components. `GalleryApp` owns theme state and passes it into `ChatScreen` as a controlled value and callback.
- Use Phosphor for icons. Give every icon-only control an accessible name.
- `src/styles.css` is the only source of design token values. Light and dark share one semantic token vocabulary with values switched at the root. Do not add raw colors, theme-specific component classes, or component theme side effects.

## Design gallery

- Render the production `ChatScreen` in every scenario.
- Keep fixtures deterministic. Do not add network requests, timers, random values, or current dates.
- Make gallery callbacks update visible state. Do not use no-op handlers.
- Keep `/` focused on the ready preview. Put scenario controls only on `/__design`.
