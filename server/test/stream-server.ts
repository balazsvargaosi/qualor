import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

/**
 * One request that reached a {@link streamServer}, answered by hand: the test says when the status
 * line comes and writes the body piece by piece, so what the client sees and when is the test's.
 */
export interface HandAnswer {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The request's body, read whole before the answer was handed over. */
  body: string;
  /** Settles when the connection is closed: the client hung up, or the server did. */
  closed: Promise<void>;
  /** The status line and headers, sent at once, so the client has them before any body. */
  head(status?: number, headers?: Record<string, string>): void;
  /** One piece of the body, as one HTTP chunk. Settles when it is written. */
  write(piece: string | Buffer): Promise<void>;
  /** The last piece, if any, and the end of the body. Settles when it is written. */
  end(piece?: string | Buffer): Promise<void>;
  /** The connection is cut, as a server that crashes cuts it. */
  cut(): void;
}

/**
 * A loopback HTTP server that answers nothing by itself: each request is handed to the test through
 * `next()`, whole, to answer as it likes (never, slowly, in pieces, or by cutting the connection).
 * `connections` counts the connections made to it, so a test can tell that nothing was sent.
 */
export async function streamServer() {
  const waiting: ((answer: HandAnswer) => void)[] = [];
  const arrived: HandAnswer[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const closed = new Promise<void>((resolve) => {
        if (req.socket.destroyed) resolve();
        else req.socket.once('close', () => resolve());
      });
      const answer: HandAnswer = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(parts).toString('utf8'),
        closed,
        head: (status = 200, headers = { 'content-type': 'text/event-stream' }) => {
          res.writeHead(status, headers);
          res.flushHeaders();
        },
        write: (piece) =>
          new Promise<void>((resolve, reject) => {
            res.write(piece, (err) => (err ? reject(err) : resolve()));
          }),
        end: (piece) =>
          new Promise<void>((resolve) => {
            if (piece === undefined) res.end(() => resolve());
            else res.end(piece, () => resolve());
          }),
        cut: () => {
          req.socket.destroy();
        },
      };
      const taker = waiting.shift();
      if (taker) taker(answer);
      else arrived.push(answer);
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/x`,
    host: `127.0.0.1:${port}`,
    port,
    /** The connections made so far. */
    connections: () => connections,
    /** The oldest request not taken yet, waiting for one if none has come. */
    next: (): Promise<HandAnswer> => {
      const answer = arrived.shift();
      if (answer) return Promise.resolve(answer);
      return new Promise<HandAnswer>((resolve) => waiting.push(resolve));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type StreamServer = Awaited<ReturnType<typeof streamServer>>;

/**
 * Runs `test` against a {@link streamServer} that is closed after it, with real timers back first:
 * a test that moves the timers by hand does not leave them faked for the next.
 */
export async function withStreamServer(
  test: (server: StreamServer) => Promise<void>,
): Promise<void> {
  const server = await streamServer();
  try {
    await test(server);
  } finally {
    vi.useRealTimers();
    await server.close();
  }
}
