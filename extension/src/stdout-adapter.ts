/**
 * Version-sensitive adapter for the dsh web stdout startup line.
 *
 * The line is human-readable and therefore NOT the primary startup protocol:
 * the extension pre-allocates the port itself and health-probes the server.
 * This adapter exists for diagnostics only (reading the port back out of the
 * child's logs), and is isolated here with fixtures so a future dsh change of
 * the line format breaks exactly one tested module.
 */

export interface UrlLineParse {
  url: string;
  host: string;
  port: number;
}

/** Current format: `dsh web: http://127.0.0.1:3080 (LAN: http://...:3080)` */
const URL_LINE = /dsh web:\s+(https?:\/\/([\w.[\]]+):(\d+))/;

export function parseUrlLine(line: string): UrlLineParse | undefined {
  const match = URL_LINE.exec(line);
  if (!match) return undefined;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { url: match[1], host: match[2], port };
}

/** Scan a raw stdout chunk for the startup line; last match wins. */
export function parsePortFromStream(chunk: string): number | undefined {
  let port: number | undefined;
  for (const line of chunk.split(/\r?\n/)) {
    const parsed = parseUrlLine(line);
    if (parsed) port = parsed.port;
  }
  return port;
}
