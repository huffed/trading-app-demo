/**
 * Low-level cTrader Open API client.
 *
 * Wire format:
 *   ┌──────────────┬──────────────────────────┐
 *   │ length (4B)  │ ProtoMessage bytes       │
 *   │ uint32 BE    │ payloadType+payload+id   │
 *   └──────────────┴──────────────────────────┘
 *
 * Length excludes itself; ProtoMessage is the standard envelope from
 * OpenApiCommonMessages.proto. Every request carries a `clientMsgId`
 * (a UUID) so we can correlate the async response.
 *
 * This client is one-shot per cron run: open TLS, do work, close. We
 * deliberately don't keep a long-lived connection because a Next.js
 * cron route fires hourly and lives for seconds — pooling would add
 * complexity without buying anything.
 */
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import { lookupType } from "./proto/loader";

/** PROTO_OA_ERROR_RES payload type — kept inline so the dispatch path
 *  doesn't depend on the higher-level messages module. */
const ERROR_RES_PAYLOAD_TYPE = 2142;

export interface CTraderEndpoint {
  host: string;
  port: number;
}

export const ENDPOINTS: Record<"demo" | "live", CTraderEndpoint> = {
  demo: { host: "demo.ctraderapi.com", port: 5035 },
  live: { host: "live.ctraderapi.com", port: 5035 },
};

interface PendingRequest {
  expectedRes: number | null;
  resolve: (msg: ProtoMessageDecoded) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ProtoMessageDecoded {
  payloadType: number;
  payload: Uint8Array;
  clientMsgId?: string;
}

export interface SendOptions {
  /** PayloadType integer the response is expected to carry. When set, an
   *  unexpected payloadType triggers reject — typically a PROTO_OA_ERROR_RES
   *  carrying the failure detail. */
  expectedRes?: number;
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number;
}

export class CTraderClient {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly endpoint: CTraderEndpoint) {}

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const sock = tls.connect(
        { host: this.endpoint.host, port: this.endpoint.port, servername: this.endpoint.host },
        () => resolve()
      );
      sock.on("data", (chunk) => this.onData(chunk));
      sock.on("error", (err) => {
        this.failAllPending(err);
        if (!sock.authorized && !this.closed) reject(err);
      });
      sock.on("close", () => {
        this.failAllPending(new Error("cTrader connection closed unexpectedly"));
        this.closed = true;
      });
      this.socket = sock;
    });
    return this.connectPromise;
  }

  close(): void {
    this.closed = true;
    this.socket?.end();
    this.failAllPending(new Error("cTrader connection closed by client"));
  }

  /** Send a request and await the matching response (correlated by
   *  clientMsgId). The payload is the raw protobuf bytes for the
   *  inner message — call sites encode via lookupType + encode. */
  async send(
    payloadType: number,
    payload: Uint8Array,
    options: SendOptions = {}
  ): Promise<ProtoMessageDecoded> {
    if (!this.socket || this.closed) {
      throw new Error("cTrader: send() called on closed/uninitialised connection");
    }
    const ProtoMessage = lookupType("ProtoMessage");
    const clientMsgId = randomUUID();
    const env = ProtoMessage.encode(
      ProtoMessage.create({ payloadType, payload, clientMsgId })
    ).finish();
    const frame = Buffer.alloc(4 + env.length);
    frame.writeUInt32BE(env.length, 0);
    Buffer.from(env).copy(frame, 4);

    return new Promise<ProtoMessageDecoded>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 15000;
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error(`cTrader: timeout after ${timeoutMs}ms (payloadType=${payloadType})`));
      }, timeoutMs);
      this.pending.set(clientMsgId, {
        expectedRes: options.expectedRes ?? null,
        resolve,
        reject,
        timer,
      });
      this.socket!.write(frame, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(clientMsgId);
          reject(err);
        }
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) return; // wait for more
      const body = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      this.dispatch(body);
    }
  }

  private dispatch(body: Buffer): void {
    const ProtoMessage = lookupType("ProtoMessage");
    const decoded = ProtoMessage.decode(body) as unknown as ProtoMessageDecoded;
    const id = decoded.clientMsgId;
    if (!id) return; // unsolicited event (e.g. heartbeat) — ignore for now
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    // Special-case ERROR_RES (2142): decode the OA-level error so callers
    // see "ALREADY_LOGGED_IN" or whatever, not a generic "wrong payload type".
    if (decoded.payloadType === ERROR_RES_PAYLOAD_TYPE) {
      const ErrorRes = lookupType("ProtoOAErrorRes");
      const err = ErrorRes.decode(decoded.payload) as unknown as {
        errorCode?: string;
        description?: string;
      };
      pending.reject(
        new Error(`cTrader ${err.errorCode ?? "ERROR"}: ${err.description ?? "no description"}`)
      );
      return;
    }
    if (pending.expectedRes !== null && decoded.payloadType !== pending.expectedRes) {
      pending.reject(
        new Error(
          `cTrader: expected payloadType=${pending.expectedRes}, got ${decoded.payloadType}`
        )
      );
      return;
    }
    pending.resolve(decoded);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
