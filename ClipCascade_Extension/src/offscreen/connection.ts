import { Client } from "@stomp/stompjs";
import {
  HEARTBEAT_MS,
  RECONNECT_DELAY_MS,
  SEND_DESTINATION,
  SUBSCRIPTION_DESTINATION,
} from "../shared/constants";

export interface ConnectionEvents {
  /** Runs before every (re)connect; return false to stop reconnecting. */
  beforeConnect(): Promise<boolean>;
  onConnected(): void;
  onDisconnected(reason?: string): void;
  onMessage(body: string): void;
}

/**
 * STOMP over websocket to /clipsocket, with automatic reconnects.
 *
 * Lives in the offscreen document rather than the service worker: Chrome
 * applies declarativeNetRequest rules (used to attach the session cookie) to
 * websockets opened by extension pages, but not to ones opened by workers.
 */
export class Connection {
  private client?: Client;
  private brokerURL?: string;
  private waiters: Array<(connected: boolean) => void> = [];

  constructor(private readonly events: ConnectionEvents) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  get active(): boolean {
    return this.client?.active ?? false;
  }

  get url(): string | undefined {
    return this.brokerURL;
  }

  start(brokerURL: string): void {
    void this.stop();
    this.brokerURL = brokerURL;
    const client = new Client({
      brokerURL,
      reconnectDelay: RECONNECT_DELAY_MS,
      // The server sends a heartbeat every 20 s; a silent socket is dropped and reopened.
      heartbeatIncoming: HEARTBEAT_MS,
      heartbeatOutgoing: HEARTBEAT_MS,
      beforeConnect: async () => {
        if (!(await this.events.beforeConnect())) await client.deactivate();
      },
      onConnect: () => {
        client.subscribe(SUBSCRIPTION_DESTINATION, (message) => this.events.onMessage(message.body));
        this.events.onConnected();
        this.resolveWaiters(true);
      },
      onStompError: (frame) => this.events.onDisconnected(frame.headers.message || "Server rejected the connection"),
      onWebSocketClose: () => {
        if (this.client === client) this.events.onDisconnected();
      },
    });
    this.client = client;
    client.activate();
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.brokerURL = undefined;
    this.resolveWaiters(false);
    await client?.deactivate();
  }

  publish(body: string): void {
    if (!this.client?.connected) throw new Error("Not connected to the server");
    this.client.publish({ destination: SEND_DESTINATION, body });
  }

  /** Resolves true once connected, or false after the timeout or a stop(). */
  waitConnected(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (!this.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (connected: boolean) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(connected);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.push(done);
    });
  }

  private resolveWaiters(connected: boolean): void {
    for (const waiter of [...this.waiters]) waiter(connected);
  }
}
