import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export async function record(key, capture, options = {}) {
  const fixturesDir = resolve(options.fixturesDir ?? "evidence");
  const path = fixturePath(key, fixturesDir);

  // This check happens before capture(), so rerunning a live command cannot
  // silently spend money and replace the provenance attached to a claim.
  if (existsSync(path)) {
    throw new Error(`record(${JSON.stringify(key)}): refusing to overwrite ${path}`);
  }

  const value = await capture();
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) {
    throw new Error(`record(${JSON.stringify(key)}): value is not JSON-serializable`);
  }

  mkdirSync(dirname(path), { recursive: true });
  // `wx` closes the race between the preflight check and the write.
  writeFileSync(path, `${json}\n`, { encoding: "utf8", flag: "wx" });
  return JSON.parse(json);
}

function fixturePath(key, fixturesDir) {
  if (
    typeof key !== "string" ||
    key.trim() !== key ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) ||
    key.includes("..")
  ) {
    throw new Error(`record(): unsafe key ${JSON.stringify(key)}`);
  }
  const path = resolve(fixturesDir, `${key}.json`);
  const rel = relative(fixturesDir, path);
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    throw new Error(`record(): key escaped fixtures directory: ${JSON.stringify(key)}`);
  }
  return path;
}
