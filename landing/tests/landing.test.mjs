import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

const publicDirectory = join(import.meta.dirname, "..", "public");

test("the launch page states the product boundaries and working access links", async () => {
  const html = await readFile(join(publicDirectory, "index.html"), "utf8");

  assert.match(html, /Latest 50 active sessions/);
  assert.match(html, /last 90 days/i);
  assert.match(html, /Codex and Pi/);
  assert.match(html, /bounded redacted digest/i);
  assert.match(html, /Illustrative report/);
  assert.match(html, /https:\/\/github\.com\/ram4-dev\/rate-your-flow/);
  assert.match(html, /https:\/\/x\.com\/ram4_dev/);
  assert.match(html, /mailto:ramirocarnicersouble8@gmail\.com/);
  assert.match(html, /releases\/download\/v0\.1\.7\/rate-your-flow-0\.1\.7\.tgz/);
  assert.match(html, /releases\/download\/v0\.1\.7\/rate-your-flow-x\.mp4/);
  for (const dimension of ["Reliability", "Communication", "Context efficiency", "Productivity", "Hygiene"]) {
    assert.match(html, new RegExp(dimension));
  }
  assert.match(html, /Illustrative total: 82, the simple average/);
});

test("the landing keeps its accessibility essentials", async () => {
  const html = await readFile(join(publicDirectory, "index.html"), "utf8");
  const css = await readFile(join(publicDirectory, "styles.css"), "utf8");

  assert.match(html, /<main/);
  assert.match(html, /<nav aria-label=/);
  assert.match(html, /<details/);
  assert.match(html, /aria-live="polite"/);
  assert.match(css, /prefers-reduced-motion/);
});
