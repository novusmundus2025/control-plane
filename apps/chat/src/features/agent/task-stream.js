// Persisted snapshots make reconnect/replay independent of a process-local buffer.
export async function streamAgentTask(response, first, readTask, { interval = 500, lifetime = 30000 } = {}) {
  let closed = false, wake;
  const onClose = () => { closed = true; wake?.(); };
  response.on("close", onClose);
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  response.flushHeaders?.();
  const started = Date.now();
  let payload = first;
  let previous = "", lastWrite = 0;
  try {
    while (!closed) {
      const serialized = JSON.stringify(payload);
      const changed = serialized !== previous;
      const frame = changed ? "data: " + serialized + "\n\n" : Date.now() - lastWrite >= 5000 ? ": heartbeat\n\n" : "";
      previous = serialized;
      if (frame && !response.write(frame)) {
        // A slow reader reconnects to the latest persisted snapshot.
        break;
      }
      if (frame) lastWrite = Date.now();
      if (["completed", "failed", "cancelled"].includes(payload.state) || Date.now() - started >= lifetime) break;
      await new Promise(resolve => {
        const timer = setTimeout(done, interval);
        function done() { clearTimeout(timer); wake = null; resolve(); }
        wake = done;
      });
      if (!closed) payload = await readTask();
    }
  } catch {
    // Closing the stream sends the client through the authenticated recovery path.
  } finally {
    response.off("close", onClose);
    if (!closed) response.end();
  }
}
