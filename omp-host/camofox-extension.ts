export function makeCamofoxFactory(identity) {
  return function camofox(pi) {
    const z = pi.zod;

    const BASE = (process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377").replace(/\/+$/, "");
    const USER_ID = process.env.CAMOFOX_USER_ID || "default";
    const SESSION_KEY = (identity && identity.thread) || "default";
    const ACCESS_KEY = process.env.CAMOFOX_ACCESS_KEY || "";

    function authHeaders(extra) {
      const h = { ...(extra || {}) };
      if (ACCESS_KEY) h["authorization"] = `Bearer ${ACCESS_KEY}`;
      return h;
    }

    async function call(method, path, body, signal) {
      const headers = authHeaders(body !== undefined ? { "content-type": "application/json" } : {});
      let res;
      try {
        res = await fetch(`${BASE}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal,
        });
      } catch (e) {
        throw new Error(
          `camofox daemon unreachable at ${BASE} (${e?.message || e}). The browser may be ` +
            `starting or unavailable — fall back to the read tool or the native browser.`,
        );
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try {
          msg = JSON.parse(text).error || text;
        } catch {}
        throw new Error(`camofox ${method} ${path} -> ${res.status}: ${msg}`);
      }
      return text ? JSON.parse(text) : {};
    }

    const q = (extra) => new URLSearchParams({ userId: USER_ID, ...(extra || {}) }).toString();
    const ok = (text, details) => ({ content: [{ type: "text", text }], details: details || {} });

    pi.registerTool({
      name: "camo_open",
      label: "Camo Open",
      description:
        "Open a new tab in the anti-detection (Camoufox/Firefox) browser at a URL and return its tabId. " +
        "Prefer this over the native browser or read tool for sites that block bots — Cloudflare, Google, " +
        "login-walled, or anti-scraping pages.",
      parameters: z.object({ url: z.string().describe("Absolute URL to open") }),
      async execute(_id, p, signal) {
        const r = await call("POST", "/tabs", { userId: USER_ID, sessionKey: SESSION_KEY, url: p.url }, signal);
        return ok(`Opened tab ${r.tabId}\nurl: ${r.url || p.url}${r.title ? `\ntitle: ${r.title}` : ""}`, r);
      },
    });

    pi.registerTool({
      name: "camo_navigate",
      label: "Camo Navigate",
      description:
        "Navigate an existing tab to a URL, or run a search macro (@google_search, @youtube_search, " +
        "@wikipedia_search, @reddit_search, @amazon_search, ...). Provide url, or macro + query.",
      parameters: z.object({
        tabId: z.string(),
        url: z.string().optional().describe("Absolute URL"),
        macro: z.string().optional().describe("Search macro, e.g. @google_search"),
        query: z.string().optional().describe("Query string for the macro"),
      }),
      async execute(_id, p, signal) {
        const r = await call(
          "POST",
          `/tabs/${p.tabId}/navigate`,
          { userId: USER_ID, sessionKey: SESSION_KEY, url: p.url, macro: p.macro, query: p.query },
          signal,
        );
        return ok(`Navigated to ${r.url || p.url || `${p.macro} ${p.query || ""}`.trim()}`, r);
      },
    });

    pi.registerTool({
      name: "camo_snapshot",
      label: "Camo Snapshot",
      description:
        "Get a tab's accessibility tree with stable element refs (e1, e2, ...) to use in camo_click / " +
        "camo_type. Refs reset on navigation — re-snapshot after navigating.",
      parameters: z.object({ tabId: z.string() }),
      async execute(_id, p, signal) {
        const r = await call("GET", `/tabs/${p.tabId}/snapshot?${q()}`, undefined, signal);
        return ok(`url: ${r.url}\n\n${r.snapshot || "(empty page)"}`, {
          refsCount: r.refsCount,
          truncated: r.truncated,
        });
      },
    });

    pi.registerTool({
      name: "camo_click",
      label: "Camo Click",
      description: "Click an element by ref (from camo_snapshot, e.g. e1) or by CSS selector.",
      parameters: z.object({
        tabId: z.string(),
        ref: z.string().optional().describe("Element ref like e1"),
        selector: z.string().optional().describe("CSS selector"),
      }),
      async execute(_id, p, signal) {
        const r = await call(
          "POST",
          `/tabs/${p.tabId}/click`,
          { userId: USER_ID, sessionKey: SESSION_KEY, ref: p.ref, selector: p.selector },
          signal,
        );
        return ok(`clicked ${p.ref || p.selector || "element"}`, r);
      },
    });

    pi.registerTool({
      name: "camo_type",
      label: "Camo Type",
      description: "Type text into an element by ref or CSS selector. Set pressEnter to submit the field.",
      parameters: z.object({
        tabId: z.string(),
        text: z.string(),
        ref: z.string().optional(),
        selector: z.string().optional(),
        pressEnter: z.boolean().optional().default(false),
      }),
      async execute(_id, p, signal) {
        const r = await call(
          "POST",
          `/tabs/${p.tabId}/type`,
          { userId: USER_ID, sessionKey: SESSION_KEY, text: p.text, ref: p.ref, selector: p.selector, pressEnter: p.pressEnter },
          signal,
        );
        return ok(`typed into ${p.ref || p.selector || "element"}${p.pressEnter ? " + Enter" : ""}`, r);
      },
    });

    pi.registerTool({
      name: "camo_scroll",
      label: "Camo Scroll",
      description: "Scroll a tab up, down, left, or right.",
      parameters: z.object({
        tabId: z.string(),
        direction: z.enum(["up", "down", "left", "right"]).optional().default("down"),
        amount: z.number().optional().describe("Pixels to scroll (default ~one viewport)"),
      }),
      async execute(_id, p, signal) {
        const r = await call(
          "POST",
          `/tabs/${p.tabId}/scroll`,
          { userId: USER_ID, sessionKey: SESSION_KEY, direction: p.direction, amount: p.amount },
          signal,
        );
        return ok(`scrolled ${p.direction}`, r);
      },
    });

    pi.registerTool({
      name: "camo_list_tabs",
      label: "Camo List Tabs",
      description: "List the open browser tabs for this thread (each thread sees only its own tabs).",
      parameters: z.object({}),
      async execute(_id, _p, signal) {
        const r = await call("GET", `/tabs?${q()}`, undefined, signal);
        const filtered = { ...r, tabs: (r.tabs || []).filter((t) => t.listItemId === SESSION_KEY) };
        return ok(JSON.stringify(filtered, null, 2), filtered);
      },
    });

    pi.registerTool({
      name: "camo_close_tab",
      label: "Camo Close Tab",
      description: "Close a browser tab by tabId.",
      parameters: z.object({ tabId: z.string() }),
      async execute(_id, p, signal) {
        await call("DELETE", `/tabs/${p.tabId}?${q()}`, undefined, signal);
        return ok(`closed tab ${p.tabId}`);
      },
    });

    pi.registerTool({
      name: "camo_screenshot",
      label: "Camo Screenshot",
      description: "Capture a PNG screenshot of a tab so you can see the rendered page.",
      parameters: z.object({
        tabId: z.string(),
        fullPage: z.boolean().optional().default(false),
      }),
      async execute(_id, p, signal) {
        let res;
        try {
          res = await fetch(`${BASE}/tabs/${p.tabId}/screenshot?${q({ fullPage: String(!!p.fullPage) })}`, {
            headers: authHeaders(),
            signal,
          });
        } catch (e) {
          throw new Error(`camofox daemon unreachable at ${BASE} (${e?.message || e}).`);
        }
        if (!res.ok) {
          throw new Error(`camofox screenshot -> ${res.status}: ${await res.text()}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }],
          details: { bytes: buf.length },
        };
      },
    });
  };
}
