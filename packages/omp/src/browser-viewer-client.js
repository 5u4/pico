const canvas = document.querySelector("#page");
const status = document.querySelector("#status");
const url = document.querySelector("#url");
const text = document.querySelector("#text");
const tabs = document.querySelector("#tabs");
const tabsStatus = document.querySelector("#tabs-status");
const refreshTabs = document.querySelector("#refresh-tabs");
const selectTab = document.querySelector("#select-tab");
const context = canvas.getContext("2d");
let socket;
let width = 1280;
let height = 720;
let point = { x: 0, y: 0 };
const heldKeys = new Map();
const heldButtons = new Map();
const modifiers = (event) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);
const send = (message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const mouse = (eventType, button, event, clickCount = 0) => ({
  type: "input_mouse",
  eventType,
  ...point,
  button,
  clickCount,
  modifiers: event ? modifiers(event) : 0,
  deltaX: 0,
  deltaY: 0,
});
const key = (event, eventType) => ({
  type: "input_keyboard",
  eventType,
  key: event.key,
  code: event.code,
  text:
    eventType === "keyDown" && !event.ctrlKey && !event.metaKey && event.key.length === 1
      ? event.key
      : "",
  windowsVirtualKeyCode: event.keyCode,
  modifiers: modifiers(event),
});
const release = () => {
  for (const message of heldKeys.values())
    send({ ...message, eventType: "keyUp", text: "", modifiers: 0 });
  for (const button of heldButtons.keys()) send(mouse("mouseReleased", button));
  heldKeys.clear();
  heldButtons.clear();
};
const updateTabs = async (request) => {
  release();
  tabs.disabled = true;
  refreshTabs.disabled = true;
  selectTab.disabled = true;
  tabsStatus.textContent = request.action === "select" ? "Switching tab" : "Refreshing tabs";
  try {
    const response = await fetch("./tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    tabs.replaceChildren(
      ...result.tabs.map((tab) => {
        const option = document.createElement("option");
        option.value = tab.tabId;
        option.textContent = `${tab.tabId}: ${tab.title || "Untitled"} (${tab.url})`;
        return option;
      }),
    );
    const active = result.tabs.find((tab) => tab.active);
    tabs.value = active?.tabId ?? "";
    if (active) url.textContent = active.url;
    tabsStatus.textContent =
      result.tabs.length === 0
        ? "No open tabs. Send a message in chat to open a page."
        : active
          ? `Showing ${active.tabId}. Click the page to continue.`
          : "Choose a tab, then select Show tab.";
  } catch (error) {
    tabsStatus.textContent =
      error instanceof Error
        ? error.message
        : "Could not update tabs. Refresh tabs to check the browser.";
  } finally {
    tabs.disabled = tabs.options.length === 0;
    refreshTabs.disabled = false;
    selectTab.disabled = tabs.value === "";
  }
};
const disconnect = () => {
  release();
  const previous = socket;
  socket = undefined;
  previous?.close();
  status.textContent = "Disconnected. Reconnect this viewer or request a new link in chat.";
};
const connect = () => {
  disconnect();
  if (document.hidden) return;
  status.textContent = "Connecting";
  const connection = new WebSocket(new URL("./ws", location.href).href.replace(/^http/, "ws"));
  socket = connection;
  connection.onmessage = async (event) => {
    if (socket !== connection) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "status")
        status.textContent = message.connected
          ? "Connected. Click the page to control it."
          : "Browser disconnected. Send a message in chat to reopen it.";
      if (message.type === "url") url.textContent = message.url ?? "";
      if (message.type !== "frame" || typeof message.data !== "string") return;
      const image = new Image();
      image.src = `data:${message.data.startsWith("iVBOR") ? "image/png" : "image/jpeg"};base64,${message.data}`;
      await image.decode();
      if (socket !== connection || document.hidden) return;
      width = message.metadata.deviceWidth;
      height = message.metadata.deviceHeight;
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width;
        canvas.height = image.height;
      }
      context.drawImage(image, 0, 0);
      send({ type: "ack", seq: message.seq });
    } catch {
      if (socket === connection) {
        disconnect();
        status.textContent = "Unable to render this stream. Request a new viewer link in chat.";
      }
    }
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    heldKeys.clear();
    heldButtons.clear();
    socket = undefined;
    status.textContent = "Browser disconnected or expired. Send a message in chat to reopen it.";
  };
  connection.onerror = () => connection.close();
};
const movePoint = (event) => {
  const bounds = canvas.getBoundingClientRect();
  point = {
    x: Math.max(0, Math.min(width - 1, ((event.clientX - bounds.left) * width) / bounds.width)),
    y: Math.max(0, Math.min(height - 1, ((event.clientY - bounds.top) * height) / bounds.height)),
  };
};
const buttonName = (button) => ["left", "middle", "right"][button] ?? "none";
canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  canvas.focus();
  canvas.setPointerCapture(event.pointerId);
  movePoint(event);
  const button = buttonName(event.button);
  heldButtons.set(button, event.pointerId);
  send(mouse("mousePressed", button, event, event.detail || 1));
});
canvas.addEventListener("pointermove", (event) => {
  movePoint(event);
  send(mouse("mouseMoved", heldButtons.keys().next().value ?? "none", event));
});
canvas.addEventListener("pointerup", (event) => {
  movePoint(event);
  const button = buttonName(event.button);
  send(mouse("mouseReleased", button, event, event.detail || 1));
  heldButtons.delete(button);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("lostpointercapture", release);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    movePoint(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    send({
      ...mouse("mouseWheel", "none", event),
      deltaX: event.deltaX * unit,
      deltaY: event.deltaY * unit,
    });
  },
  { passive: false },
);
canvas.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
  if (event.isComposing) return;
  event.preventDefault();
  const message = key(event, "keyDown");
  heldKeys.set(event.code, message);
  send(message);
  if (event.key === "Escape") canvas.blur();
});
canvas.addEventListener("keyup", (event) => {
  event.preventDefault();
  if (!heldKeys.has(event.code)) return;
  send(key(event, "keyUp"));
  heldKeys.delete(event.code);
});
const insertText = (value) => {
  for (const character of value)
    send({
      type: "input_keyboard",
      eventType: "char",
      key: "",
      code: "",
      text: character,
      windowsVirtualKeyCode: 0,
      modifiers: 0,
    });
};
canvas.addEventListener("paste", (event) => {
  event.preventDefault();
  insertText(event.clipboardData.getData("text/plain"));
});
canvas.addEventListener("compositionend", (event) => insertText(event.data));
canvas.addEventListener("blur", release);
window.addEventListener("blur", release);
window.addEventListener("pagehide", disconnect);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disconnect();
  else connect();
});
document.querySelector("#connect").addEventListener("click", connect);
document.querySelector("#disconnect").addEventListener("click", disconnect);
refreshTabs.addEventListener("click", () => updateTabs({ action: "refresh" }));
tabs.addEventListener("change", () => {
  selectTab.disabled = tabs.value === "";
});
document.querySelector("#tabs-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (tabs.value) updateTabs({ action: "select", tabId: tabs.value });
});
document.querySelector("#text-form").addEventListener("submit", (event) => {
  event.preventDefault();
  insertText(text.value);
  text.value = "";
  canvas.focus();
});
connect();
