// Electron supplies parentPort; Node IPC needs the same MessageEvent envelope for production listeners.
Object.defineProperty(process, "parentPort", {
  value: {
    on(event, listener) {
      process.on(event, message => listener({ data: message }));
    },
    postMessage(message) {
      process.send?.(message);
    },
  },
});
