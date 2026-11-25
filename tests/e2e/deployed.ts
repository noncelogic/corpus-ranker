// The deployed candidate the deploy lane's suites run against
// (.github/workflows/deploy.yml, .github/scripts/deploy-candidate.sh): its
// base URL (RANKER_E2E_URL) and the API key it booted with
// (RANKER_E2E_API_KEY). The suites (tests/e2e/*.e2e.ts, npm run test:e2e;
// tests/journeys/*.journey.ts, npm run test:journeys) only ever talk to it
// over HTTP, as a client would; they are not part of `npm test`.
export interface Deployed {
  url: string;
  apiKey: string;
}

export function deployed(env: Readonly<Record<string, string | undefined>> = process.env): Deployed {
  const url = env.RANKER_E2E_URL ?? "";
  const apiKey = env.RANKER_E2E_API_KEY ?? "";
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error("RANKER_E2E_URL must name the deployed candidate (http[s]://host:port)");
  if (apiKey === "") throw new Error("RANKER_E2E_API_KEY must hold an API key the deployed candidate accepts");
  return { url: url.replace(/\/+$/, ""), apiKey };
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** One request to the deployed service; a JSON body is sent as JSON, and the answer is parsed as JSON. */
export async function call(
  target: Deployed,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key !== undefined) headers.authorization = `Bearer ${options.key}`;
  const res = await fetch(`${target.url}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
