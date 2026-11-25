// Journeys: what an agent does with the deployed candidate, end to end over
// HTTP (deploy lane, .github/workflows/deploy.yml). Each run captures fresh
// bytes, so a journey never depends on an earlier run's data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { call, deployed } from "../e2e/deployed.ts";

const target = deployed();
const FUNDING = "cr_corpus_funding";

test("capture: an agent captures an opportunity into the funding corpus, and capturing the same bytes again returns the same Original", async () => {
  const bytes = Buffer.from(JSON.stringify({ program: "e2e fellowship", run: randomUUID() }));
  const request = {
    content_base64: bytes.toString("base64"),
    media_type: "application/json",
    source: { source_kind: "upload", source: "deploy-lane-journey" },
    captured_by: "agent:journey",
    raw_metadata: { journey: "capture" },
  };
  const first = await call(target, "POST", `/v1/corpora/${FUNDING}/originals`, { body: request });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(first.body.corpus_id, FUNDING);
  assert.equal(first.body.byte_size, bytes.byteLength);
  assert.equal(first.body.content_hash, hash);

  const again = await call(target, "POST", `/v1/corpora/${FUNDING}/originals`, { body: request });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.id, first.body.id, "content-addressed: the same Original");
});

test("rank: an agent asks for the funding top N under funding-fit and fetches the saved Ranked View again", async () => {
  const derived = await call(target, "POST", "/v1/top-n", {
    body: { corpus_id: FUNDING, policy_name: "funding-fit", query: { subject: "deploy-lane journey" }, n: 5 },
  });
  assert.equal(derived.status, 200, JSON.stringify(derived.body));
  assert.equal(derived.body.policy_id, "cr_pol_funding");
  assert.equal(derived.body.policy_version, 1);
  assert.ok(Array.isArray(derived.body.entries));
  assert.match(String(derived.body.view_id), /^cr_view_/);

  const saved = await call(target, "POST", "/v1/top-n", { body: { view_id: derived.body.view_id } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.view_id, derived.body.view_id);
  assert.deepEqual(saved.body.entries, derived.body.entries);
});
