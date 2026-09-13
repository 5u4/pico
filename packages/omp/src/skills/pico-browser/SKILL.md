---
name: pico-browser
description: Browse websites, inspect pages, fill forms, capture screenshots, and hand login to the user through Pico's isolated interactive browser viewer.
---

# Pico browser

Use `pico_browser` through its discovered tool or `xd://pico_browser`. Read its schema for the current operations. Do not invoke `agent-browser`, install browser software, attach to a user's Chrome, or use another browser tool. Pico binds browser ownership, state, and executable paths. Never ask the model or user to invent a session identifier.

## Browse a page

1. Open the URL with `{"op":"open","url":"https://example.com"}`.
2. Take `{"op":"snapshot","interactive":true}`.
3. Use fresh refs such as `@e2` for `click`, `fill`, `type`, `hover`, `check`, or `select`.
4. Take another snapshot after navigation or a page change. Discard old refs.

`get` reads text, HTML, values, counts, the URL, or the title. `tabs` lists, creates, selects, and closes tabs only in your browser. `frame` selects an iframe or returns to the main page with `selector:null`. `dialog` inspects, accepts, or dismisses JavaScript dialogs. Uploads require absolute file paths and the user's authorization to send those files.

Use `eval` for JavaScript inside the page, not host commands. Use a bounded `wait` for a selector, text, URL, load state, or page expression. Do not use waits to block on a human. `screenshot` returns image content and a durable file path.

If an operation is cancelled or its connection fails, its page action may already have happened. Inspect the page before retrying a purchase, form submission, or other mutation.

## Hand login to the user

Browsers start headless. Every successful page operation returns a viewer URL. `{"op":"viewer"}` obtains the current link.

1. Give the user the viewer URL and name the login step they need to complete.
2. Tell them to send a normal message in this chat when finished.
3. End your turn. Do not poll, schedule a wake-up, or leave a tool waiting.
4. After their message, take a fresh snapshot before continuing.

The viewer accepts mouse clicks, dragging, wheel scrolling, keyboard input, and paste. Its text field can send passwords or one-time codes to the focused page field. Escape releases viewer keyboard focus. Hiding or disconnecting the viewer stops frames. Viewer frames are not an accessibility tree; use snapshots for page semantics.

If login opens a popup, use Refresh tabs, select that page, then Show tab. These controls affect only this browser and do not resume the assistant.

The link works on the daemon machine. It does not automatically work on a phone or another computer. A private tunnel must preserve the loopback host and origin. The viewer has no all-session dashboard or remote authentication service. Local processes can reach native loopback streams; browser separation is not an operating-system sandbox.

Only after the user explicitly asks for a native window, call `{"op":"mode","mode":"headed","userRequested":true}`. This restarts the browser and may lose transient page state. Saved authentication remains. Returning to headless also requires an explicit request. Never switch modes merely because automation failed. Native passkey prompts and operating-system dialogs are not guaranteed to work in the viewer.

## Keep or share login state

Each chat and each actual child SDK session has a separate browser process and separate writable credentials. A revived child reuses its own identity. Main and children cannot select each other's tabs. Browsers survive ordinary OMP session eviction.

Native autosave preserves cookies and site storage across restart and normal close. It is not a full Chrome profile. Use `{"op":"checkpoint"}` after the user finishes login when a definite save is needed. If restore failed, Pico preserves the previous state and reports a warning. Complete login again, then use `checkpoint` to repair this owner's saved state. Do not change mode until that save succeeds.

To reuse login in future chats, first get the user's approval to copy **all saved sites** from this browser. Then call `{"op":"remember_login","userApproved":true}`. Pico publishes one login seed atomically. New browser owners copy the seed once into private writable state. Existing owners do not change, and ordinary autosaves never write back to the seed. Do not publish a shared seed when the user authorized login only for this chat.

`{"op":"close"}` closes this browser without deleting its credentials. Archiving a chat closes Main and all its children. Do not close a browser while the user is using the viewer.

## Idle lifetime and installation

The default browser idle timeout is three hours. The operator can set `[browser] idle_timeout = "3 hours"` or positive whole milliseconds in `config.toml`, then restart Pico. Genuine viewer input resets the native idle timer; passive frames do not. Explicit timeouts also apply in headed mode. Native-window clicks are not guaranteed to reset that timer.

If Chrome is missing, ask the operator to run `pico browser install` for the daemon's root, or `pico browser install /absolute/root`. Do not install it from an agent tool or use `npx` or a global `agent-browser` installation.
