# Web design direction

Pico adapts [Beautiful UI](https://www.beautifului.dev/)'s quiet, transcript-first character to a developer chat workspace. Its light and dark themes use cool neutrals and one restrained cobalt interaction accent. Assistant prose stays in the reading flow. User messages, tool activity, and thinking use only enough enclosure to clarify their role. The composer is the sole elevated surface.

The accepted screen has a workspace sidebar on the left and one chat column. Desktop collapse leaves a rail for expanding navigation, starting a chat, managing schedules, and adding a workspace. Mobile keeps the full tree in a native dialog, independent of desktop collapse.

The sidebar adapts [Beautiful UI's Sidebar Nav](https://www.beautifului.dev/r/sidebar-nav.json) without replacing the workspace tree with a switcher. Workspace disclosure controls lazy chat loading, not conversation selection. Collapse preserves that state and is not persisted. Hover decoration stays separate from selection and keyboard focus, with no continuous animation work.

When sources disagree, follow them in this order:

1. The production presentation types and controlled component contracts.
2. The executable token values in `src/styles.css`.
3. This design note.
4. External references.

The application uses one registry-owned connection. `App` owns registry lifetime. `WorkspaceChat` owns workspace and chat selection, drafts, and commands. `transcript-presentation.ts` maps transcript records into display values. Presentation components remain controlled and domain-free.

Schedules open in one controlled native dialog above the retained chat. An explicit workspace selector keeps management available when no chat tabs are open. Mobile closes its navigation dialog before opening Schedules and restores focus to the persistent navigation button.

The list distinguishes valid definitions from invalid files. Enabled and paused describe scheduling state, not execution success. The editor changes metadata only. One-time input uses UTC with a named local-time preview; repeating input keeps the stored five-field cron and IANA timezone. Daily and weekly shortcuts only fill the cron field. Existing destinations remain untouched unless explicitly changed.

Creation and instruction edits hand off to reviewable chat drafts because the schedule tools require a real chat identity and prepared source files. A nonempty draft is never overwritten, and nothing is sent automatically. Opening a draft does not create a schedule. Users refresh the list after the agent reports creation or repair.

The existing registry connection serves schedule reads and mutations. Opening, changing workspace, refocusing the browser, explicit refresh, and successful mutations refresh server data without polling. Failed refreshes retain a labeled snapshot. Refresh does not replace an open form; changed definitions are flagged, and dirty navigation requires discard confirmation. Metadata saves are last-write-wins for the changed fields because the service has no revision precondition.

Both themes use the same semantic token vocabulary. `WorkspaceChat` owns theme state and passes it into the controlled `ChatScreen`. A synchronous head bootstrap selects a stored choice or the initial operating-system preference before React and the stylesheet load.

User, assistant, thinking, and notice bodies share Markdown formatting. Streaming parses each complete accumulated block, because splitting the animated tail can break Markdown syntax. Code and tables scroll within their containers rather than widening the conversation. Raw HTML stays escaped, unsafe URLs are not links, and Markdown images require an explicit click instead of fetching remote resources automatically.

Tool arguments remain literal. Tool output has no format metadata, so both inline disclosures and the detail pane default to Source with an explicit Markdown view. Do not guess from tool names or payload text. Copy always preserves the original payload, including whitespace, regardless of the selected view. Tool names, summaries, and truncated hover previews remain literal.

Thinking and tool activity adapt [Beautiful UI's Thinking trace](https://www.beautifului.dev/r/thinking-state.json). Quiet disclosure headers reveal an indented trace without enclosing each step in a card. Tool groups reveal compact rows first, then each call's full arguments and output. Collapsed groups still expose failures, running calls, and unknown states.

Thinking and tool groups expand during activity and collapse when it ends. Manual toggles override automatic expansion, including after completion, so updates do not close a trace someone chose to inspect. Individual tool arguments and output remain collapsed until opened.

Disclosure preferences belong to each retained conversation entry, because message and tool IDs can repeat across chats. Switching chats or closing and reopening a tab preserves that conversation's choices. Closing the chat removes them with its entry.

Group only consecutive tool calls within one assistant message. Prose, thinking, images, and message boundaries end a group so grouping never moves content across the conversation. Keep unanchored snapshot results and live calls in separate groups until an assistant message supplies their position. Group expansion follows member call IDs through settlement. Closing a group preserves individual detail preferences.

Assistant message fragments share one visual flow. Compact thinking and tool boundaries stay together, while prose has more space and user messages separate turns. Layout derives those boundaries from the rendered block kinds without regrouping or reordering transcript records.

Live thinking and gaps before the next activity use [Beautiful UI's Dots loading state](https://www.beautifului.dev/r/loading-state.json). Waiting is a display status, not a synthetic assistant message. A running, connected session shows it only when no streaming draft or running tool already supplies feedback.

Assistant prose adapts [Beautiful UI's streaming text](https://www.beautifului.dev/r/streaming-text.json) with a live caret after the final rendered Markdown block. The caret is CSS-only so it does not alter the source or split Markdown syntax. No demo playback timer delays tokens or replays settled history. Message settlement removes its live treatment; run completion or connection loss removes waiting.

The trace uses actual execution states, not demo timers or invented elapsed time. The web event stream has no thinking-end event, so thinking remains active until a later content block, message settlement, run completion, or connection loss. Live tool events lack positions within assistant content, so live calls retain their trailing position until settlement. Interaction transitions stop after feedback and respect reduced motion.

The quiet ring below the composer opens current context estimates, not cumulative billed usage. History and context share one snapshot request. Reading an absent or archived session never initializes OMP, so unavailable is not 0%. Compaction and model changes invalidate the snapshot without polling. Percentages may exceed 100%; only the ring is clamped.

Context-estimate failures leave loaded history readable and show an error in the details. Disconnected selection and disclosure keep the cached estimate without attempting a refresh.

Context details use a controlled native popover above the footer, outside the composer's clipping form. The card stays mounted through refreshes and closes on chat selection. Disconnected values are labeled as the last snapshot. Category estimates may not add up exactly to the provider-derived total.
