---
name: pico-browser
description: Browse websites, inspect pages, fill forms, capture screenshots, import an approved local Cookie header or JSON export, and hand login to the user through Pico's isolated interactive browser viewer.
---

# Pico browser

Use `pico_browser` through its discovered tool or `xd://pico_browser`. Read its schema for the current operations. Do not invoke `agent-browser`, install browser software, attach to a user's Chrome, or use another browser tool. Pico binds browser ownership, state, and executable paths. Never ask the model or user to invent a session identifier.

## Browse a page

1. Open the URL with `{"op":"open","url":"https://example.com"}`.
2. Take `{"op":"snapshot","interactive":true}`.
3. Use fresh refs such as `@e2` for `click`, `fill`, `type`, `hover`, `check`, or `select`.
4. Take another snapshot after navigation or a page change. Discard old refs.

`get` reads text, HTML, values, counts, the URL, or the title. `tabs` lists, creates, selects, and closes tabs only in your browser. `frame` selects an iframe or returns to the main page with `selector:null`. `dialog` inspects, accepts, or dismisses JavaScript dialogs.

Open a local `file:` preview only after the user explicitly requests it. Include `userRequested:true` on `open` or `tabs` with `action:"new"`. This flag records that request, not an independent approval. Preview permission does not authorize uploading or otherwise transmitting the file's contents.

Upload files only after the user explicitly approves sending those files to the page. Use absolute paths and include the required flag: `{"op":"upload","selector":"input[type=file]","files":["/absolute/path/to/file"],"userApproved":true}`. Never set `userApproved:true` without that approval. The flag records the model's assertion of user approval; it is not independent approval or an operating-system sandbox. Permission to read or preview a file does not authorize uploading it.

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

## Import login from a cookie file

Cookie files grant access like passwords. Keep their contents out of model context, tool arguments, and chat. Do not read the file to inspect it or ask the user to paste it.

1. Ask the user to log in with their own browser and open DevTools Network. Have them select a request to the intended site.
2. Have them copy the whole `Cookie` request header value, such as `key=value; other=value`, into a text file on the daemon machine. No browser extension or manual JSON conversion is needed.
3. Get the file's absolute path, the request's target URL, and explicit approval to import into this chat's browser. Reading or uploading approval does not authorize cookie import. A path on another computer is not accessible to Pico.
4. Call `{"op":"import_cookies","path":"/absolute/path/to/cookies.txt","format":"header","url":"https://x.com","userApproved":true}`. Set the flag only after that approval.
5. Navigate to the site or reload its open tab, then take a fresh snapshot to check login.

Header mode accepts one `Cookie` header value, optionally prefixed with `Cookie:`, with surrounding whitespace or a final newline. Values remain literal, including percent sequences, quotes, embedded equals signs, and empty values. Duplicate cookie names and malformed entries reject the whole file. A complete request, cURL command, or `Set-Cookie` response header is not a cookie file.

A request header has no cookie attributes. Header mode creates new host-only session cookies for exactly the target URL's hostname, with path `/` regardless of the URL path. It sets `Secure` for HTTPS and leaves SameSite unspecified. It sets `HttpOnly=false` by default so JavaScript can read CSRF cookies, as sites such as X require. Names starting with `__Http-` or `__Host-Http-` instead get `HttpOnly=true` and require HTTPS. Other imported authentication cookies remain readable by JavaScript. These are new attributes, not the original settings. Secure cookie prefixes require HTTPS. The target must be an HTTP or HTTPS URL without credentials.

To preserve the original attributes, use a JSON export instead. Call `{"op":"import_cookies","path":"/absolute/path/to/cookies.json","userApproved":true}` after approval. `format:"json"` is optional. The file must contain a nonempty JSON array or an object with a `cookies` array. Each cookie needs string `name`, `value`, and `domain` fields. Netscape files, URL-only cookies, and browser profiles are not supported.

JSON import preserves `path`, `secure`, `httpOnly`, and host-only scope. Names starting with `__Http-` or `__Host-Http-` require both `secure:true` and `httpOnly:true`. `__Host-Http-` also requires host-only scope and path `/`.

JSON accepts `expires` or `expirationDate` in epoch seconds. `session:true` ignores an otherwise valid expiry, but conflicting expiry aliases still reject the whole file. `session:false` requires a nonnegative expiry. An expiry of `-1` means a session cookie.

SameSite accepts case-insensitive `Strict`, `Lax`, `None`, `no_restriction`, and `unspecified`. `None` requires `secure:true`. Partitioned cookies and invalid metadata are rejected before browser startup. Other export metadata does not become native cookie options.

A successful receipt reports the submitted count and completed checkpoint, not successful site authentication. Import preserves unrelated cookies and site storage, saves this owner's state across close and restart, and does not publish a login seed. Sharing with future chats requires the separate `remember_login` approval below.

If import fails after submission, cookies may already have changed. Follow its outcome message and inspect the browser before deciding whether to retry. Pico leaves the source file untouched. The user can delete it manually after import.

## Keep or share login state

Each chat and each actual child SDK session has a separate browser process and separate writable credentials. A revived child reuses its own identity. Main and children cannot select each other's tabs. Browsers survive ordinary OMP session eviction.

Native autosave preserves cookies and site storage across restart and normal close. It is not a full Chrome profile. Use `{"op":"checkpoint"}` after the user finishes login when a definite save is needed. If restore failed, Pico preserves the previous state and reports a warning. Complete login again, then use `checkpoint` to repair this owner's saved state. Do not change mode until that save succeeds.

To reuse login in future chats, first get the user's approval to copy **all saved sites** from this browser. Then call `{"op":"remember_login","userApproved":true}`. Pico publishes one login seed atomically. New browser owners copy the seed once into private writable state. Existing owners do not change, and ordinary autosaves never write back to the seed. Do not publish a shared seed when the user authorized login only for this chat.

`{"op":"close"}` closes this browser without deleting its credentials. Archiving a chat closes Main and all its children. Do not close a browser while the user is using the viewer.

## Idle lifetime and installation

The default browser idle timeout is three hours. The operator can set `[browser] idle_timeout = "3 hours"` or positive whole milliseconds in `config.toml`, then restart Pico. Genuine viewer input resets the native idle timer; passive frames do not. Explicit timeouts also apply in headed mode. Native-window clicks are not guaranteed to reset that timer.

If Chrome is missing, ask the operator to run `pico browser install` for the daemon's root, or `pico browser install /absolute/root`. Do not install it from an agent tool or use `npx` or a global `agent-browser` installation.
