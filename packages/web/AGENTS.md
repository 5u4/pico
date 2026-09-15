# Web package rules

## Dependency direction

- Keep `src/chat` and `src/components/ui` controlled and presentation-only.
- Never import pico packages, Effect, atoms, RPC, or router APIs from presentation components.
- Keep registry lifetime in `App` and application state and command guards in `WorkspaceChat`.
- Map records into `chat-model.ts` display types before rendering.
- Import concrete files directly. Do not add barrel files.

## Components

- Keep transcript items ordered. Tool activity may split two assistant segments.
- Keep all component props serializable display values and callbacks. Do not pass transport records or errors.
- Keep app-shell state out of presentation components. `WorkspaceChat` owns theme state and passes it into `ChatScreen` as a controlled value and callback.
- Use Phosphor for icons. Give every icon-only control an accessible name.
- `src/styles.css` is the only source of design token values. Light and dark share one semantic token vocabulary with values switched at the root. Do not add raw colors, theme-specific component classes, or component theme side effects.
