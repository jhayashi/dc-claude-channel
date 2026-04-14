---
name: webxdc-builder
description: Build WebXDC apps for Delta Chat — static HTML apps or Familiar apps with a Claude backend. Use when a user asks to build an app, game, tool, dashboard, or interactive experience in their chat.
user-invocable: false
allowed-tools:
  - mcp__dc__dc_send_webxdc
  - mcp__dc__dc_familiar_create
  - mcp__dc__dc_familiar_update
  - mcp__dc__dc_familiar_list
  - mcp__dc__dc_familiar_delete
  - mcp__dc__reply
---

# WebXDC Builder

Build interactive apps that run inside Delta Chat. Two paths: **static** (one-shot HTML) or **Familiar** (HTML + server-side handler with persistent state).

## Decision Tree

| Question | Static (`dc_send_webxdc`) | Familiar (`dc_familiar_create`) |
|----------|--------------------------|--------------------------------|
| Needs server-side logic? | No | Yes |
| Needs persistent state? | No | Yes (set `persistent: true`) |
| Needs LLM responses? | No | Yes (`ctx.requestLLM`) — see cost note below |
| Multi-user interaction? | Read-only sharing | Yes (route on `senderAddr`) |
| Examples | info cards, charts, slideshows | polls, quizzes, games, chatbots, dashboards |

**Rule of thumb:** If tapping a button should change something for everyone or call the LLM, use Familiar. If the app is purely client-side, use static.

> **`ctx.requestLLM` cost:** each call dispatches a full agent turn — it takes several seconds and consumes tokens from the chat's agent budget. Debounce, cache, or pre-compute answers when possible. Don't call it on every keystroke or from `setUpdateListener`.

---

## WebXDC HTML Rules (MANDATORY)

Every WebXDC HTML file -- static or Familiar -- MUST follow these rules:

1. **No external resources.** No CDN links, no `fetch()`, no external URLs. Everything must be inline in a single HTML file.
2. **Include the WebXDC bridge:** `<script src="webxdc.js"></script>` -- the messenger injects this at runtime. Never bundle a copy.
3. **Receive data:**
   ```js
   window.webxdc.setUpdateListener(function(update) {
     var data = update.payload;
     // handle data...
   }, 0);
   ```
4. **Send data (REQUIRED senderAddr):**
   ```js
   window.webxdc.sendUpdate({
     payload: {
       senderAddr: window.webxdc.selfAddr,
       type: 'my_action',
       // ...your data
     }
   }, 'description');
   ```
   Every payload MUST include `senderAddr: window.webxdc.selfAddr`. Payloads without it are silently dropped.
5. **Replay safety:** `setUpdateListener(fn, 0)` replays ALL updates from the beginning on every app open. Handlers must rebuild state from the full replay, not append incrementally.
6. **XSS prevention:** Use `textContent` (not `innerHTML`) for any user-supplied data -- including anything that came from `ctx.requestLLM()` in a handler. LLM output can contain `<script>` or `<img onerror>` via prompt injection.
7. **All CSS/JS/assets inline.** Single HTML file, no imports.
8. **Debounce `sendUpdate`.** Never fire it directly from a high-frequency event (rapid taps, mousemove, keystrokes). WebXDC rate-limits `sendUpdate` to roughly once every 10 seconds per app; bursts get queued or dropped silently. For tap-driven apps, batch into a delta and flush on a timer (see counter pattern below).

---

## Static App Flow

For apps with no server-side logic. You build the HTML, zip it into an `.xdc`, and send it.

### Steps

1. Write a complete HTML file following the rules above.
2. Create the `.xdc` bundle (a zip containing `index.html` and `manifest.toml`):
   ```bash
   mkdir -p /tmp/myapp && cat > /tmp/myapp/index.html << 'HTMLEOF'
   <!DOCTYPE html>
   <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
   <script src="webxdc.js"></script>
   <style>body { font-family: system-ui; padding: 1em; }</style>
   </head><body>
   <h1>Hello WebXDC</h1>
   <script>
   window.webxdc.setUpdateListener(function(update) {
     document.getElementById('out').textContent = JSON.stringify(update.payload);
   }, 0);
   </script>
   <pre id="out"></pre>
   </body></html>
   HTMLEOF
   echo 'name = "My App"' > /tmp/myapp/manifest.toml
   cd /tmp/myapp && zip -j /tmp/myapp.xdc index.html manifest.toml
   ```
3. Send with `dc_send_webxdc`:
   ```
   dc_send_webxdc(chat_id: "42", xdc_path: "/tmp/myapp.xdc")
   ```

### When to use

- Dashboards, charts, info cards with no interaction
- Read-only content (formatted reports, slideshows)
- Client-side-only games (no scoring server, no shared state)

---

## Familiar App Flow

For apps that need server-side logic, persistent state, or LLM integration. You provide HTML (the frontend) and a handler (the backend).

### Steps

1. Write the HTML (same rules as static, but it sends user actions via `sendUpdate`).
2. Write the handler -- a JS string that processes user actions server-side.
3. Create with `dc_familiar_create`:
   ```
   dc_familiar_create(
     chat_id: "42",
     title: "My Quiz",
     html: "<full HTML string>",
     handler: "<handler JS string>",
     initial_state: {"score": 0, "round": 1},
     persistent: true
   )
   ```

### Handler API

The handler is a JS string that the runtime compiles and runs **inside the dispatcher process**. Dangerous globals (`fs`, `process`, `fetch`, `require`, `Bun`, `Function`, `eval`, `setTimeout`, etc.) are shadowed as `undefined` to discourage casual misuse, but this is **not a sandbox** — a determined handler can re-acquire them via prototype-chain tricks. Treat the handler source as code you would personally run in the dispatcher.

This has two practical consequences:

1. **Never embed unreviewed user input into a handler string.** If a user says "make a counter that starts at 5", generate a handler with the literal value `5`, don't concatenate `${userValue}` into handler source. The user approving `dc_familiar_create` is the security gate, and they're approving the handler they see.
2. **Keep handlers short and explicit.** Standard JS builtins (Math, JSON, Date, Array, String, Promise) work normally. Anything outside the explicit `ctx` API should make you stop and ask whether you need it.

The handler receives two arguments:

```js
function handler(update, ctx) { ... }
```

- **`update`** -- the payload object sent by the frontend via `sendUpdate`. Always has `senderAddr`.
- **`ctx.state`** -- persistent state object. Mutate it directly; changes survive handler invocations. If `persistent: true`, state is saved to disk after each handler call.
- **`ctx.sendUpdate(payload)`** -- push data back to the frontend. The frontend receives it via `setUpdateListener`. The payload is automatically wrapped in `{payload: ...}`.
- **`ctx.requestLLM(prompt)`** -- send a prompt to Claude and get a text response back. Async (use `await`).
- **`ctx.appId`** -- the app's unique ID.
- **`ctx.chatId`** -- the chat ID where the app lives.

### Managing Familiar apps

- **`dc_familiar_update`** -- push a payload to the frontend from the agent side (outside the handler).
- **`dc_familiar_list`** -- list all Familiar apps in a chat.
- **`dc_familiar_delete`** -- remove an app instance.

---

## Handler Patterns

### Pure deterministic (game scoring)

No LLM calls -- just state logic.

**HTML (counter app):** Note the debounced send — rapid taps accumulate into `pendingDelta` and flush after 250ms. Without this, the sendUpdate rate limit (rule 8) silently drops bursts.

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<script src="webxdc.js"></script>
<style>
  body { font-family: system-ui; text-align: center; padding: 2em; }
  button { font-size: 1.5em; padding: 0.5em 1em; margin: 0.5em; touch-action: manipulation; }
  #count { font-size: 3em; margin: 1em 0; }
</style>
</head><body>
<h2>Counter</h2>
<div id="count" aria-live="polite">0</div>
<button onclick="addDelta(1)">+1</button>
<button onclick="addDelta(-1)">-1</button>
<script>
// Authoritative state lives in JS vars, never in the DOM.
var serverCount = 0;
var pendingDelta = 0;
var flushTimer = null;
function render() {
  document.getElementById('count').textContent = String(serverCount + pendingDelta);
}
function addDelta(n) {
  pendingDelta += n;
  render();  // optimistic: show serverCount + pendingDelta
  if (flushTimer) return;
  flushTimer = setTimeout(function() {
    var d = pendingDelta; pendingDelta = 0; flushTimer = null;
    window.webxdc.sendUpdate({
      payload: { senderAddr: window.webxdc.selfAddr, type: 'add', delta: d }
    }, 'add ' + d);
  }, 250);
}
window.webxdc.setUpdateListener(function(update) {
  // Server is authoritative. Overwrite serverCount on every echo, then re-render.
  if (update.payload && typeof update.payload.count === 'number') {
    serverCount = update.payload.count;
    render();
  }
}, 0);
</script>
</body></html>
```

**Handler:**
```js
if (update.type === 'add') {
  var delta = typeof update.delta === 'number' ? update.delta : 0;
  ctx.state.count = (ctx.state.count || 0) + delta;
}
ctx.sendUpdate({ count: ctx.state.count });
```

> **Never parse the DOM to reconstruct app state — keep a JS variable, render from it.** `setUpdateListener(fn, 0)` replays every update from serial 0 on app open, so anything that mutates state *inside* the listener (e.g. `counts[k]++`) multiplies by open-count. Store the authoritative snapshot in a JS variable, overwrite it from each update, and render imperatively.

**Notes:**
- The HTML renders optimistically from `serverCount + pendingDelta` for responsiveness. When the server echo arrives, `serverCount` is overwritten and `pendingDelta` has already been flushed — the next render snaps to the authoritative value.
- The handler validates `update.delta` (rule: never trust client-supplied fields without a type check) before applying it. Treat `update` the way you'd treat `req.body` in a web handler.

### Pure LLM (chat assistant)

Forward everything to Claude and relay the response.

**Handler:**
```js
if (update.type === 'ask') {
  var answer = await ctx.requestLLM(update.question);
  ctx.sendUpdate({ type: 'answer', text: answer });
}
```

**HTML (answer rendering — `textContent` is mandatory):**
```html
<div id="answer"></div>
<script>
  window.webxdc.setUpdateListener(function(update) {
    if (update.payload && update.payload.type === 'answer') {
      // textContent — NOT innerHTML. LLM output can contain <script> or
      // <img src=x onerror=...> triggered by prompt injection.
      document.getElementById('answer').textContent = update.payload.text;
    }
  }, 0);
</script>
```

> **Use `textContent`, never `innerHTML`**, when rendering any value that came from `ctx.requestLLM()` or user input. An LLM response may contain `<img src=x onerror=...>` triggered by prompt injection; `innerHTML` executes it, `textContent` shows it as literal text.

### Hybrid (deterministic + LLM)

Use state for game logic, LLM for content generation.

**Handler (trivia game):**
```js
if (update.type === 'start') {
  var q = await ctx.requestLLM(
    'Generate a trivia question as JSON: {"question":"...","answer":"...","choices":["a","b","c","d"]}'
  );
  try {
    var parsed = JSON.parse(q);
    ctx.state.currentAnswer = parsed.answer;
    ctx.state.score = ctx.state.score || 0;
    ctx.sendUpdate({ type: 'question', data: parsed });
  } catch (e) {
    ctx.sendUpdate({ type: 'error', text: 'Failed to parse question' });
  }
} else if (update.type === 'answer') {
  var correct = update.choice === ctx.state.currentAnswer;
  if (correct) ctx.state.score = (ctx.state.score || 0) + 1;
  ctx.sendUpdate({
    type: 'result',
    correct: correct,
    score: ctx.state.score,
    correctAnswer: ctx.state.currentAnswer
  });
}
```

### Multi-user (using senderAddr)

Track per-user state for polls, collaborative apps, etc.

**Handler (poll):**
```js
if (update.type === 'vote') {
  if (!ctx.state.votes) ctx.state.votes = {};
  ctx.state.votes[update.senderAddr] = update.option;

  // Recount every time — server computes the authoritative tally from ctx.state.
  var counts = {};
  var addrs = Object.keys(ctx.state.votes);
  for (var i = 0; i < addrs.length; i++) {
    var opt = ctx.state.votes[addrs[i]];
    counts[opt] = (counts[opt] || 0) + 1;
  }
  ctx.sendUpdate({ type: 'results', counts: counts, totalVoters: addrs.length });
}
```

**HTML (poll client — render from the server's authoritative counts, never accumulate locally):**
```html
<div id="results"></div>
<script>
  var latestResults = null;
  window.webxdc.setUpdateListener(function(update) {
    if (update.payload && update.payload.type === 'results') {
      latestResults = update.payload.counts;  // overwrite, don't accumulate
      render(latestResults);
    }
  }, 0);
  function render(counts) {
    var el = document.getElementById('results');
    el.textContent = '';  // clear
    Object.keys(counts).forEach(function(k) {
      var row = document.createElement('div');
      row.textContent = k + ': ' + counts[k];  // textContent, never innerHTML
      el.appendChild(row);
    });
  }
</script>
```

> **Never `counts[k]++` inside `setUpdateListener`.** Replay-from-serial-0 on every app open multiplies votes by the open-count. The server sends authoritative totals; the client overwrites a JS variable and re-renders.

---

## Integration with dc_schedule

For Familiar apps that need periodic updates (dashboards, daily digests, reminders), combine with `dc_schedule`:

```
dc_schedule(
  chat_id: "42",
  cron: "0 9 * * *",
  prompt: "Fetch the latest stats and push them to the dashboard familiar app (app_id: abc123) using dc_familiar_update."
)
```

The scheduler fires a synthetic user turn to the chat's agent, which can then call `dc_familiar_update` to push fresh data to the app. The Familiar app's `setUpdateListener` picks up the update and re-renders.

This pattern is useful for:
- Daily summary dashboards
- Periodic data refreshes
- Timed game rounds
- Reminder/notification apps
