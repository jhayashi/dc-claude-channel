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
| Needs LLM responses? | No | Yes (`ctx.requestLLM`) |
| Multi-user interaction? | Read-only sharing | Yes (route on `senderAddr`) |
| Examples | info cards, charts, slideshows | polls, quizzes, games, chatbots, dashboards |

**Rule of thumb:** If tapping a button should change something for everyone or call the LLM, use Familiar. If the app is purely client-side, use static.

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
6. **XSS prevention:** Use `textContent` (not `innerHTML`) for any user-supplied data.
7. **All CSS/JS/assets inline.** Single HTML file, no imports.

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

The handler is a JS string. It runs in a sandbox with dangerous globals (`fs`, `process`, `fetch`, `require`, `Bun`, `setTimeout`, etc.) shadowed as `undefined`. Only standard JS builtins (Math, JSON, Date, Array, String, etc.) and the context object are available.

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

**HTML (counter app):**
```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<script src="webxdc.js"></script>
<style>
  body { font-family: system-ui; text-align: center; padding: 2em; }
  button { font-size: 1.5em; padding: 0.5em 1em; margin: 0.5em; }
  #count { font-size: 3em; margin: 1em 0; }
</style>
</head><body>
<h2>Counter</h2>
<div id="count">0</div>
<button onclick="send('increment')">+1</button>
<button onclick="send('decrement')">-1</button>
<script>
function send(action) {
  window.webxdc.sendUpdate({
    payload: { senderAddr: window.webxdc.selfAddr, type: action }
  }, action);
}
window.webxdc.setUpdateListener(function(update) {
  if (update.payload && update.payload.count !== undefined) {
    document.getElementById('count').textContent = update.payload.count;
  }
}, 0);
</script>
</body></html>
```

**Handler:**
```js
if (update.type === 'increment') {
  ctx.state.count = (ctx.state.count || 0) + 1;
} else if (update.type === 'decrement') {
  ctx.state.count = (ctx.state.count || 0) - 1;
}
ctx.sendUpdate({ count: ctx.state.count });
```

### Pure LLM (chat assistant)

Forward everything to Claude and relay the response.

**Handler:**
```js
if (update.type === 'ask') {
  var answer = await ctx.requestLLM(update.question);
  ctx.sendUpdate({ type: 'answer', text: answer });
}
```

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

  // Count votes per option
  var counts = {};
  var addrs = Object.keys(ctx.state.votes);
  for (var i = 0; i < addrs.length; i++) {
    var opt = ctx.state.votes[addrs[i]];
    counts[opt] = (counts[opt] || 0) + 1;
  }
  ctx.sendUpdate({ type: 'results', counts: counts, totalVoters: addrs.length });
}
```

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
