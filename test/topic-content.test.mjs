import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveExistingWikiRel, topicContent } from "../src/topic-content.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "topic-content-"));
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(vault, "wiki", "sources"), { recursive: true });
  return { root, vault };
}

test("topic content resolves moved source pages by stable source slug", () => {
  const { root, vault } = makeVault();
  const oldRel = "wiki/sources/2026-07-08--2026-07-06-captured-2-whatsapp-image-2026-04-07-at-23-00-58-1-jpeg-679011a133.md";
  const newRel = "wiki/sources/2026-07-09--2026-07-06-captured-2-whatsapp-image-2026-04-07-at-23-00-58-1-jpeg-679011a133.md";
  fs.writeFileSync(path.join(vault, newRel), [
    "---",
    "type: source",
    "---",
    "# WhatsApp Image Capture",
    "",
    "OCR text is available."
  ].join("\n"));

  assert.equal(resolveExistingWikiRel(vault, oldRel), newRel);
  const rendered = topicContent({ vaultsRoot: root }, { vault: "Research-vault", path: oldRel, title: "Captured image" });
  assert.match(rendered, /WhatsApp Image Capture/);
  assert.match(rendered, /OCR text is available/);
});
