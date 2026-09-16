# Web design direction

Pico adapts [Beautiful UI](https://www.beautifului.dev/)'s quiet, transcript-first character to a developer chat workspace. Its light and dark themes use cool neutrals and one restrained cobalt interaction accent. Assistant prose stays in the reading flow. User messages, tool activity, and thinking use only enough enclosure to clarify their role. The composer is the sole elevated surface.

The accepted screen has a workspace sidebar on the left and one chat column. Desktop collapse leaves a rail for expanding navigation, starting a chat, and adding a workspace. Mobile keeps the full tree in a native dialog, independent of desktop collapse. There is no right detail pane.

The sidebar adapts [Beautiful UI's Sidebar Nav](https://www.beautifului.dev/r/sidebar-nav.json) without replacing the workspace tree with a switcher. Workspace disclosure controls lazy chat loading, not conversation selection. Collapse preserves that state and is not persisted. Hover decoration stays separate from selection and keyboard focus, with no continuous animation work.

When sources disagree, follow them in this order:

1. The production presentation types and controlled component contracts.
2. The executable token values in `src/styles.css`.
3. This design note.
4. External references.

The application uses one registry-owned connection. `App` owns registry lifetime. `WorkspaceChat` owns workspace and chat selection, drafts, and commands. `transcript-presentation.ts` maps transcript records into display values. Presentation components remain controlled and domain-free.

Both themes use the same semantic token vocabulary. `WorkspaceChat` owns theme state and passes it into the controlled `ChatScreen`. A synchronous head bootstrap selects a stored choice or the initial operating-system preference before React and the stylesheet load.

Thinking and tool activity adapt [Beautiful UI's Thinking trace](https://www.beautifului.dev/r/thinking-state.json). Quiet disclosure headers reveal an indented trace without enclosing each step in a card. Tool groups reveal compact rows first, then each call's full arguments and output. Collapsed groups still expose failures, running calls, and unknown states.

Group only consecutive tool calls within one assistant message. Prose, thinking, images, and message boundaries end a group so grouping never moves content across the conversation. Keep unanchored snapshot results and live calls in separate groups until an assistant message supplies their position. Group expansion follows member call IDs through settlement. Closing a group preserves individual detail preferences.

Assistant message fragments share one visual flow. Compact thinking and tool boundaries stay together, while prose has more space and user messages separate turns. Layout derives those boundaries from the rendered block kinds without regrouping or reordering transcript records.

Live thinking and gaps before the next activity use [Beautiful UI's Dots loading state](https://www.beautifului.dev/r/loading-state.json). Waiting is a display status, not a synthetic assistant message. A running, connected session shows it only when no streaming draft or running tool already supplies feedback.

Assistant prose adapts [Beautiful UI's streaming text](https://www.beautifului.dev/r/streaming-text.json) with a live caret and the existing append-tail blur. Received text stays authoritative, including whitespace. No demo playback timer delays tokens or replays settled history. Message settlement removes its live treatment; run completion or connection loss removes waiting.

The trace uses actual execution states, not demo timers or invented elapsed time. Live tool events lack positions within assistant content, so live calls retain their trailing position until settlement. Interaction transitions stop after feedback and respect reduced motion.
