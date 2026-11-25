// E2E: the deployed candidate answers as a running ranker (deploy lane,
// .github/workflows/deploy.yml). Liveness and readiness, the schema the
// candidate's own migrations applied (the funding Policy that 0002 seeds,
// read through the service's ranker_app login), API key enforcement and the
// contract's errors, all over HTTP against the deployment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { call, deployed } from "./deployed.ts";

const target = deployed();

test("liveness and readiness: the service answers and its database and object store are reachable", async () => {
  assert.deepEqual(await call(target, "GET", "/healthz"), { status: 200, body: { status: "ok", service: "ranker" } });
  assert.equal((await call(target, "GET", "/readyz")).status, 200);
});

test("the migrated schema is served: the funding Policy reads back with the deployment's API key", async () => {
  const res = await call(target, "GET", "/v1/policies/cr_pol_funding/versions/1", { key: target.apiKey });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, "cr_pol_funding");
  assert.equal(res.body.version, 1);
  assert.equal(res.body.corpus_id, "cr_corpus_funding");
  assert.deepEqual((res.body.dimensions as { name: string }[]).map((d) => d.name), ["Fit", "Timing", "Deadline", "Value"]);
});

test("a policy read without a key, or with a key the deployment did not issue, is refused", async () => {
  for (const key of [undefined, `${target.apiKey}x`]) {
    const res = await call(target, "GET", "/v1/policies/cr_pol_funding/versions/1", { key });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthenticated");
  }
});

test("contract errors: an unknown route is 404, a capture into a corpus that does not exist is 404 corpus_not_found", async () => {
  const unknown = await call(target, "GET", "/v1/nowhere");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "not_found");

  const capture = await call(target, "POST", "/v1/corpora/cr_corpus_absent/originals", {
    body: {
      content_base64: Buffer.from("e2e").toString("base64"),
      media_type: "text/plain",
      source: { source_kind: "upload", source: "e2e" },
      captured_by: "agent:e2e",
    },
  });
  assert.equal(capture.status, 404, JSON.stringify(capture.body));
  assert.equal(capture.body.error, "corpus_not_found");
});
