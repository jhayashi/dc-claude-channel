// Stub webxdc.js — implements exactly the surface our apps use. Injected
// into every page the harness loads, overriding the name collision the
// messenger would have injected in production.
//
// Bridges with the test process via two globals:
//   window.__harness.push(payload)   — feed an update into the app
//   window.__harness.outbound        — array of every sendUpdate call
//   window.__harness.clearOutbound() — reset between assertions
//
// Serial numbers start at 1. Apps that assert on max_serial will see it
// grow monotonically with each push.

(function () {
  var listener = null;
  var listenerSerial = 0;
  var nextSerial = 1;
  var pendingQueue = [];
  var outbound = [];
  var sentToChat = [];

  function deliver(update) {
    if (!listener) {
      pendingQueue.push(update);
      return;
    }
    try {
      listener(update);
    } catch (err) {
      console.error('webxdc-shim: listener threw', err);
    }
  }

  window.webxdc = {
    selfAddr: 'test@test.local',
    selfName: 'Test User',
    sendUpdateInterval: 0,
    sendUpdateMaxSize: 128000,

    setUpdateListener: function (cb, serial) {
      listener = cb;
      listenerSerial = serial || 0;
      var q = pendingQueue;
      pendingQueue = [];
      for (var i = 0; i < q.length; i++) {
        if (q[i].serial > listenerSerial) deliver(q[i]);
      }
      return Promise.resolve();
    },

    sendUpdate: function (update, descr) {
      outbound.push({ update: update, descr: descr });
      return Promise.resolve();
    },

    importFiles: function () {
      return Promise.resolve([]);
    },

    sendToChat: function (payload) {
      // Captured for assertions (help card's Try-it, #108).
      sentToChat.push(payload);
      return Promise.resolve();
    },
  };

  window.__harness = {
    push: function (payload) {
      var update = {
        payload: payload,
        serial: nextSerial++,
        max_serial: nextSerial - 1,
      };
      deliver(update);
    },
    outbound: outbound,
    clearOutbound: function () {
      outbound.length = 0;
    },
    getSerial: function () {
      return nextSerial - 1;
    },
    sentToChat: sentToChat,
  };
})();
