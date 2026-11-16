// The ranker's S3-compatible object store (TECH-STACK §5): originals are
// written once, keyed by the SHA-256 of their bytes, in the ranker's own
// bucket. A minimal path-style S3 client (AWS Signature Version 4 over
// node:crypto and fetch), so the object store adds no runtime dependency.
import { createHash, createHmac } from "node:crypto";

export interface ObjectStore {
  /** Store `bytes` under the content-addressed `key` (their SHA-256 hex); resolves once durable. */
  put(key: string, bytes: Buffer, mediaType: string): Promise<void>;
  /** Read back the object under `key`; null when absent. */
  get(key: string): Promise<Buffer | null>;
  /** The storage URI an Original records for `key`. */
  uri(key: string): string;
}

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

const KEY = /^[0-9a-f]{64}$/;
const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

export function s3ObjectStore(opts: S3Options): ObjectStore {
  const region = opts.region ?? "us-east-1";
  const endpoint = opts.endpoint.replace(/\/+$/, "");

  const request = async (method: "PUT" | "GET", key: string, body?: Buffer, mediaType?: string): Promise<Response> => {
    if (!KEY.test(key)) throw new Error(`object key must be a SHA-256 hex digest, got ${JSON.stringify(key)}`);
    const url = new URL(`${endpoint}/${encodeURIComponent(opts.bucket)}/${key}`);
    const payloadHash = hex(body ?? Buffer.alloc(0));
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const signed = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const signedHeaders = Object.keys(signed).join(";");
    const canonical = [
      method,
      url.pathname,
      "",
      ...Object.entries(signed).map(([k, v]) => `${k}:${v}`),
      "",
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
    if (mediaType !== undefined) headers["content-type"] = mediaType;
    return fetch(url, { method, headers, body: body === undefined ? undefined : new Uint8Array(body), signal: AbortSignal.timeout(60_000) });
  };

  return {
    async put(key, bytes, mediaType) {
      if (hex(bytes) !== key) throw new Error(`object key ${key} is not the SHA-256 of the bytes`);
      const res = await request("PUT", key, bytes, mediaType);
      if (!res.ok) throw new Error(`object store PUT ${key} failed: HTTP ${res.status} ${await res.text()}`);
      await res.arrayBuffer();
    },
    async get(key) {
      const res = await request("GET", key);
      if (res.status === 404) {
        await res.arrayBuffer();
        return null;
      }
      if (!res.ok) throw new Error(`object store GET ${key} failed: HTTP ${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    },
    uri: (key) => `s3://${opts.bucket}/${key}`,
  };
}
