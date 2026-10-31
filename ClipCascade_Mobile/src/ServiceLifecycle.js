const SHUTDOWN_TIMEOUT_MS = 15000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A timeout leaves the native owner in place. It never permits another run.
export async function stopServiceRun(bridge, timeoutMs = SHUTDOWN_TIMEOUT_MS, disableSync = true) {
  const id = bridge.getServiceRunIdSync();
  bridge.requestServiceRunStopSync(id, disableSync);
  if (!id) return;
  const deadline = Date.now() + timeoutMs;
  while (bridge.getServiceRunIdSync() === id) {
    if (Date.now() >= deadline) {
      throw new Error('Sync is still stopping. Wait and try again. A replacement was not started.');
    }
    await sleep(100);
  }
}

export async function acquireServiceRun(bridge) {
  // Replacing a run preserves the user's request to keep sync enabled.
  await stopServiceRun(bridge, undefined, false);
  const id = bridge.claimServiceRunSync();
  if (!id) throw new Error('Another sync run is starting. Wait and try again.');
  return id;
}

export function serviceRun(bridge, id) {
  const pending = new Set();
  const isOwner = () => bridge.getServiceRunIdSync() === id;
  const isCurrent = () => bridge.isServiceRunCurrentSync(id);
  return {
    isOwner,
    isCurrent,
    async setData(key, value) {
      // The native write and ownership check share the registry's lock.
      if (isOwner() && !bridge.setServiceRunValueSync(id, key, String(value))) {
        throw new Error('Could not save sync service state');
      }
    },
    track(callback) {
      return (...args) => {
        if (!isCurrent()) return Promise.resolve();
        const task = Promise.resolve().then(() => isCurrent() && callback(...args));
        pending.add(task);
        task.then(() => pending.delete(task), () => pending.delete(task));
        return task;
      };
    },
    async drain() {
      // Already-started native clipboard/notification work must finish before
      // a replacement can claim the service and install its listeners.
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
