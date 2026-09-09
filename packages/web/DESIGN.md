# Web design direction

Pico adapts [Beautiful UI](https://www.beautifului.dev/)'s quiet, transcript-first character to a developer chat workspace. Its light and dark themes use cool neutrals and one restrained cobalt interaction accent. Assistant prose stays in the reading flow. User messages, tool activity, and thinking use only enough enclosure to clarify their role. The composer is the sole elevated surface.

The accepted screen has a workspace sidebar on the left and one chat column. Mobile widths replace the sidebar with a controlled overlay. There is no right detail pane.

When sources disagree, follow them in this order:

1. The production presentation types and controlled component contracts.
2. The executable token values in `src/styles.css`.
3. The production scenarios at `/__design`.
4. This design note.
5. External references.

Future state integration belongs in one route adapter. It converts application records into the local presentation model without changing production component contracts.

Both themes use the same semantic token vocabulary. `GalleryApp` owns theme as app-shell presentation state and passes it into the controlled `ChatScreen`. A synchronous head bootstrap selects a stored choice or the initial operating-system preference before React and the stylesheet load.
