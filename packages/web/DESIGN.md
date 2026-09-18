# Web design direction

Pico adapts [Beautiful UI](https://www.beautifului.dev/)'s quiet, transcript-first character to a developer chat workspace. Its light and dark themes use cool neutrals and one restrained cobalt interaction accent. Assistant prose stays in the reading flow. User messages, tool activity, and thinking use only enough enclosure to clarify their role. The composer is the sole elevated surface.

The accepted screen has a workspace sidebar on the left and one main-content column. Desktop collapse leaves a rail for expanding navigation, starting a chat, viewing schedules, and adding a workspace. Mobile keeps the full tree in a native dialog, independent of desktop collapse.

The sidebar adapts [Beautiful UI's Sidebar Nav](https://www.beautifului.dev/r/sidebar-nav.json) without replacing the workspace tree with a switcher. Workspace disclosure controls lazy chat loading, not conversation selection. Collapse preserves that state and is not persisted. Hover decoration stays separate from selection and keyboard focus, with no continuous animation work.

When sources disagree, follow them in this order:

1. The production presentation types and controlled component contracts.
2. The executable token values in `src/styles.css`.
3. This design note.
4. External references.

The application uses one registry-owned connection. `App` owns registry lifetime. TanStack Router owns the current page and conversation selection. `WorkspaceChat` retains conversation entries, drafts, and commands. `transcript-presentation.ts` maps transcript records into display values. Presentation components remain controlled and domain-free.

New tabs have independent UUIDs in the workspace route's `tab` search parameter. This keeps browser history tied to one retained entry when a workspace has several drafts. New chat reuses a retained New only when it belongs to the target workspace, has no text or images, and is idle. Otherwise it creates another entry. Whitespace is retained text, not an empty draft. Closing a tab hides its entry without discarding its draft. Creating a chat keeps the entry's identity and position. Drafts remain in page memory only; the URL does not restore their text or images after a reload.

New tab labels use the draft's first line, trimmed, or `New chat` when that line is blank. Long labels truncate visually and expose the full first line in the tab tooltip. The label does not determine whether a draft is empty: a blank first line can still precede retained text.

While a chat is being created, other New tabs in that workspace remain editable but cannot send or select a suggestion until creation completes. Their status identifies the shared wait instead of implying that a message was submitted. If creation returns without confirmation, the draft remains editable and copyable, but every action that could create the chat stays disabled. The user must check the chat list and close that tab before starting another chat. Starter suggestions remain available for both empty and nonempty drafts when the selected chat is idle and connected. They stay hidden during creation, unconfirmed creation, model switching, sending, history replacement, or an active response. Send also requires non-whitespace text or a restored image.

The last-workspace preference is written only when the selected workspace changes. Typing and switching tabs within that workspace do not write it. If browser storage is blocked, the in-memory preference still changes without retrying on each keystroke.

Recovery replaces the scoped RPC session, not the registry or React tree, so drafts and navigation survive. The replacement waits for Events readiness before rehydrating initialized data. Runtime snapshots share a publication cut with live events. The client applies later state events without duplicating snapshot content. Notices and transient deliveries remain separate because snapshots may not contain them. Retired responses cannot overwrite recovered state. Writes are never replayed because a lost reply does not prove the daemon rejected the operation. Unpersisted server data cannot be reconstructed after a daemon restart. Unmatched browser fragments remain retained rather than running.

History navigation stays inside one chat because OMP owns its branches. Preview selection belongs to the browser and never changes the active conversation. Explicit continuation changes the native cursor without deleting later branches or undoing files and commands. A physical journal cursor preserves the selected position across restart without adding model context. Pico does not maintain a second tree. The header button is the only entry point; there is no double-Escape binding or `/tree` command.

Returning to a user entry recovers its text and images only for the initiating tab. Automatic recovery requires an empty draft that stayed unchanged during the request. Otherwise the tab retains both drafts until the user explicitly replaces the current one. Other clients retain their own drafts. A history revision change clears abandoned assistant and tool state, including after reconnect. Submission stays disabled until the authoritative replacement arrives. Notices survive replacement, but delivery events at or before its publication cut do not.

Recovered drafts use the same `AgentPrompt` attachment constraints as sending. The adapter validates before moving the native cursor. Unsupported MIME types, malformed Base64, and excessive image counts or bytes reject continuation without changing history or the current draft. Historical entries remain available for preview. Preview RPCs carry only display labels and text, including image and tool-call markers; image bodies, tool arguments, and signatures stay in the journal.

History search matches full message text, including visible thinking, summary text, and labels before clipping display excerpts. Native metadata stays out of search payloads. Visible assistant rows include unambiguous following tool results in their continuation target. Search does not change that target. Grouping stops at a fork so selecting a row never silently chooses a sibling branch.

Typed searches wait for a quiet interval to avoid repeated journal reads. Each chat's history and preview lanes coalesce queued inputs and interrupt superseded requests. An accepted newer snapshot refreshes an open panel's current query and preview, including ordinary turns and reconnects with an unchanged history revision. Duplicate snapshot cuts do not refresh the lanes. Closed panels defer refresh until reopened. Atom requests start outside the batch that notifies history observers so both read lanes can restart.

Schedules at `/schedules` is a read-only main-content page above the retained chat state. Direct links and reloads do not require a selected workspace. It shows all current definitions across every platform, including invalid definitions with unknown owners. Chat tabs, drafts, disclosure choices, and scroll positions remain mounted. Hidden chat content is inert, and its measurement, focus, and native-overlay behavior is suspended.

Rows keep definition state separate from the last recorded run. Disabled does not mean manually paused or successfully completed. Persisted execution phases do not prove current liveness. A previous definition revision's outcome stays labeled as a previous revision. The daemon calculates the next future calendar trigger using the stored cron timezone, not an execution-start promise.

Deleting a schedule retains its run history for recovery, but the overview reads history only for current definitions. A damaged record from a deleted schedule cannot block the current list. Corrupt history for a current definition still fails the snapshot and produces a redacted RPC diagnostic.

Creation and management remain LLM-only through the existing schedule tools. The page has no authoring handoff, metadata editor, or mutation controls. Read-only details show identity, targets, source paths, timeouts, and compact run status. Prompts, successful output, and execution working directories are not part of the overview response.

One global schedule atom uses the existing registry connection. Entry, browser focus or visibility return, and explicit refresh request a snapshot without polling. A timestamp identifies the snapshot, and failed or disconnected reads retain a labeled previous result. Mobile closes its navigation dialog before entering the page. Entry, including a direct link, focuses the page heading.

Schedule navigation uses real links built by the application router, so modified clicks and new-tab actions stay native. Browser Back and Forward follow the URL. Back to chats resolves the last settled conversation against the current retained entries, or returns home if that entry is gone or the visit began at `/schedules`. It restores the visible opener or a persistent navigation control without opening the mobile keyboard. The remembered entry supplies hidden chat presentation and a return destination, never command authorization.

Both themes use the same semantic token vocabulary. `WorkspaceChat` owns theme state and passes it into the controlled `ChatScreen`. A synchronous head bootstrap selects a stored choice or the initial operating-system preference before React and the stylesheet load.

User, assistant, thinking, and notice bodies share Markdown formatting. Streaming parses each complete accumulated block, because splitting the animated tail can break Markdown syntax. Code and tables scroll within their containers rather than widening the conversation. Raw HTML stays escaped, unsafe URLs are not links, and Markdown images require an explicit click instead of fetching remote resources automatically.

The todo dock renders task bodies and blocker notes as Markdown. Its summary and phase headings use noninteractive inline formatting to preserve button and heading semantics. Nested Markdown lists within a task are display content, not separately tracked subtasks, and do not change completion counts.

Tool arguments remain literal. Tool output has no format metadata, so both inline disclosures and the detail pane default to Source with an explicit Markdown view. Do not guess from tool names or payload text. Copy always preserves the original payload, including whitespace, regardless of the selected view. Tool names, summaries, and truncated hover previews remain literal.

Thinking and tool activity adapt [Beautiful UI's Thinking trace](https://www.beautifului.dev/r/thinking-state.json). Quiet disclosure headers reveal an indented trace without enclosing each step in a card. Tool groups reveal compact rows first, then each call's full arguments and output. Collapsed groups still expose failures, running calls, and unknown states.

Thinking and tool groups expand during activity and collapse when it ends. Manual toggles override automatic expansion, including after completion, so updates do not close a trace someone chose to inspect. Individual tool arguments and output remain collapsed until opened.

Disclosure preferences belong to each retained conversation entry, because message and tool IDs can repeat across chats. Switching chats or closing and reopening a tab preserves that conversation's choices. Closing the chat removes them with its entry.

Group only consecutive tool calls within one assistant message. Prose, thinking, images, and message boundaries end a group so grouping never moves content across the conversation. Keep unanchored snapshot results and live calls in separate groups until an assistant message supplies their position. Group expansion follows member call IDs through settlement. Closing a group preserves individual detail preferences.

Assistant message fragments share one visual flow. Compact thinking and tool boundaries stay together, while prose has more space and user messages separate turns. Layout derives those boundaries from the rendered block kinds without regrouping or reordering transcript records.

Live thinking and gaps before the next activity use [Beautiful UI's Dots loading state](https://www.beautifului.dev/r/loading-state.json). Waiting is a display status, not a synthetic assistant message. A running, connected session shows it only when no streaming draft or running tool already supplies feedback.

Assistant prose adapts [Beautiful UI's streaming text](https://www.beautifului.dev/r/streaming-text.json) with a live caret after the final rendered Markdown block. The caret is CSS-only so it does not alter the source or split Markdown syntax. No demo playback timer delays tokens or replays settled history. Message settlement removes its live treatment; run completion or connection loss removes waiting.

The trace uses actual execution states, not demo timers or invented elapsed time. The web event stream has no thinking-end event, so thinking remains active until a later content block, message settlement, run completion, or connection loss. Live tool events lack positions within assistant content, so live calls retain their trailing position until settlement. Interaction transitions stop after feedback and respect reduced motion.

The quiet ring at the composer's lower right opens current context estimates, not cumulative billed usage. History, context, and the current model share one snapshot request. Reading an absent or archived session never initializes OMP, so unavailable is not 0%. Compaction and model changes invalidate the snapshot without polling. Percentages may exceed 100%; only the ring is clamped.

Context-estimate failures leave loaded history readable and show an error in the details. Disconnected selection and disclosure keep the cached estimate without attempting a refresh.

Context details use a controlled native popover above the footer, outside the composer's clipping form. The card stays mounted through refreshes and closes on chat selection. Disconnected values are labeled as the last snapshot. Category estimates may not add up exactly to the provider-derived total.

The model picker at the lower left changes only the current chat through the same application operation as Discord `/switch`. It does not update the workspace default. Opening the picker on a new draft creates the chat and its configured worktree without sending the draft. This gives selection a durable chat identity before the first message.

The slash skill menu uses the current OMP session's catalog, not a workspace preview. Opening it on a new draft creates the chat and its configured worktree without sending a message. The catalog refreshes on open. Typing filters locally by name and description. Rows display the invocable `/skill:name` command. Typing its `/skill:` prefix keeps the catalog visible. Selection replaces only the current token with `/skill:name ` and preserves the surrounding draft. Enter never sends while the menu is open, including loading, empty, and error states. Escape dismisses the menu until the text or caret changes. Shift+Enter and input-method composition retain their normal behavior.

The skill menu stays above the composer within the conversation's visible bounds. Its height updates after resize, visual viewport scrolling, and welcome animation completion. Arrow navigation scrolls only the result list, so selecting a skill cannot move the conversation.

Cold reads and session opening respect the latest intentional model change. A trailing temporary retry fallback does not become durable; Pico restores the latest non-fallback role selection.

The picker stays available during an active response, including tool execution. The native model switch takes effect at the next provider call, which may occur in the same run. Pico does not abort or restart the run to switch models. Provider-specific connection resets and recovery remain OMP's responsibility. Another switch blocks selection until it finishes. A successful switch supplies the displayed model even if no history snapshot has loaded. If that switch dirties an in-flight snapshot, the snapshot still updates history and runtime state but preserves the cached model until the follow-up read returns. A later clean snapshot can supersede it. An unconfirmed journal save shows the active selection with a warning instead of reporting the switch as failed.
