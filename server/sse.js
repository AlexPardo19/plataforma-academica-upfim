/**
 * Gestor ligero de canales Server-Sent Events (SSE) por usuario para mensajería en tiempo real (HU-48, HU-49).
 */
export function createSseHub() {
  const clientsByUser = new Map();

  function registerClient(userId, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write(': connected\n\n');

    if (!clientsByUser.has(userId)) {
      clientsByUser.set(userId, new Set());
    }
    const set = clientsByUser.get(userId);
    set.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);
    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }

    const cleanup = () => {
      clearInterval(heartbeat);
      const userClients = clientsByUser.get(userId);
      if (userClients) {
        userClients.delete(res);
        if (userClients.size === 0) {
          clientsByUser.delete(userId);
        }
      }
    };

    res.on('close', cleanup);
    return cleanup;
  }

  function emitToUser(userId, eventName, payload) {
    const userClients = clientsByUser.get(userId);
    if (!userClients || userClients.size === 0) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of userClients) {
      try {
        res.write(frame);
      } catch {
        // Ignorado; el evento 'close' limpiará el socket
      }
    }
  }

  function closeAll() {
    for (const set of clientsByUser.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          // Ignorado
        }
      }
    }
    clientsByUser.clear();
  }

  return { registerClient, emitToUser, closeAll };
}
