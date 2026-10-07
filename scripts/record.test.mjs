import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { record } from "./record.mjs";

test("record writes once and refuses to spend on an existing key", async () => {
  const fixturesDir = await mkdtemp(join(tmpdir(), "gateway-record-"));
  let calls = 0;
  await record("live/example", async () => {
    calls += 1;
    return { captured: true };
  }, { fixturesDir });

  await assert.rejects(
    record("live/example", async () => {
      calls += 1;
      return { captured: false };
    }, { fixturesDir }),
    /refusing to overwrite/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(fixturesDir, "live/example.json"), "utf8")),
    { captured: true },
  );
});
