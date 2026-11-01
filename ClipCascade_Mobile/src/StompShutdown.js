// A missing DISCONNECT receipt must not keep the service owner alive forever.
export async function deactivateStompClient(client, graceMs = 5000) {
  let timer;
  try {
    const stopped = await Promise.race([
      client.deactivate().then(() => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    if (!stopped) {
      // STOMP discards the old socket's callbacks and closes it without waiting
      // for the broker. Await deactivation before service ownership is released.
      await client.deactivate({force: true});
    }
  } finally {
    clearTimeout(timer);
  }
}
