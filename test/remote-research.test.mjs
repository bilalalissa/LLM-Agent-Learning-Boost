import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLearningScaffold } from "../src/learning-store.mjs";
import {
  defaultRemoteResearchSettings,
  readRemoteResearchSettings,
  remoteRequestAllowed,
  remoteCloudContextPolicy,
  remoteResearch,
  saveRemoteSourcesToResourceInbox,
  updateRemoteResearchSettings
} from "../src/remote-research.mjs";
import { resourceInbox } from "../src/source-capture.mjs";
import { assertFetchAllowed, extractMetadata, extractReadableText, fetchUrl } from "../src/web-fetcher.mjs";

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-boost-remote-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  process.env.LEARNING_BOOST_APP_SUPPORT = path.join(root, "app-support");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  ensureLearningScaffold(vault, { vaultsRoot: root, configFile: path.join(root, "config.env") });
  return { root, vault };
}

function fakeFetch(html) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/html; charset=utf-8" },
    text: async () => html
  });
}

test("remote research defaults ask before network access", () => {
  const defaults = defaultRemoteResearchSettings();
  const blocked = remoteRequestAllowed(defaults);

  assert.equal(defaults.allowInternetWhenNeeded, false);
  assert.equal(defaults.askBeforeEachRemoteRequest, true);
  assert.equal(defaults.neverSendLocalNotesToCloudWhenBrowsing, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.requiresConfirmation, true);
  assert.equal(remoteRequestAllowed(defaults, { confirmed: true }).allowed, true);
  const policy = remoteCloudContextPolicy(defaults, { text: "local note" });
  assert.equal(policy.blocked, true);
  assert.equal(policy.allowedLocalContext, "");
});

test("remote cloud context policy blocks sensitive local context and confirms non-sensitive context", () => {
  const settings = {
    neverSendLocalNotesToCloudWhenBrowsing: false,
    cloudLocalContextPolicy: "allow_non_sensitive_with_confirmation"
  };

  const sensitive = remoteCloudContextPolicy(settings, { text: "secret", sensitivity: "critical", confirmed: true });
  const unconfirmed = remoteCloudContextPolicy(settings, { text: "public note", sensitivity: "public" });
  const confirmed = remoteCloudContextPolicy(settings, { text: "public note", sensitivity: "public", confirmed: true });

  assert.equal(sensitive.blocked, true);
  assert.equal(unconfirmed.requiresConfirmation, true);
  assert.equal(confirmed.blocked, false);
  assert.equal(confirmed.allowedLocalContext, "public note");
});

test("remote research settings persist per vault", () => {
  const { vault } = makeVault();
  const initial = readRemoteResearchSettings(vault);
  const updated = updateRemoteResearchSettings(vault, {
    allowInternetWhenNeeded: true,
    askBeforeEachRemoteRequest: false
  });

  assert.equal(initial.allowInternetWhenNeeded, false);
  assert.equal(updated.allowInternetWhenNeeded, true);
  assert.equal(updated.askBeforeEachRemoteRequest, false);
  assert.equal(readRemoteResearchSettings(vault).allowInternetWhenNeeded, true);
});

test("web fetcher blocks private, credential, and paywall-like URLs", () => {
  assert.throws(() => assertFetchAllowed("http://127.0.0.1/private"), /local, private/);
  assert.throws(() => assertFetchAllowed("https://user:pass@example.com/"), /embedded credentials/);
  assert.throws(() => assertFetchAllowed("https://example.com/login"), /login, paywall/);
  assert.doesNotThrow(() => assertFetchAllowed("https://example.com/articles/intro"));
});

test("web fetcher extracts metadata and readable text", async () => {
  const html = `<!doctype html><html><head><title>Readable Page</title><meta name="description" content="Short desc"><meta property="og:site_name" content="Example"></head><body><main><h1>Title</h1><p>Hello <strong>world</strong>.</p><script>bad()</script></main></body></html>`;
  const metadata = extractMetadata(html, "https://example.com/page");
  const readable = extractReadableText(html);
  const fetched = await fetchUrl("https://example.com/page", { fetchImpl: fakeFetch(html) });

  assert.equal(metadata.title, "Readable Page");
  assert.equal(metadata.description, "Short desc");
  assert.equal(metadata.siteName, "Example");
  assert.match(readable, /Hello world/);
  assert.equal(fetched.citation.title, "Readable Page");
  assert.match(fetched.readableText, /Title Hello world/);
});

test("remoteResearch fetches confirmed URLs and can save remote sources to ResourceInbox", async () => {
  const { vault } = makeVault();
  const html = "<html><head><title>Learning Source</title></head><body><article>Remote learning details.</article></body></html>";

  const blocked = await remoteResearch(vault, { url: "https://example.com/source" });
  assert.equal(blocked.requiresConfirmation, true);

  const result = await remoteResearch(vault, { url: "https://example.com/source" }, {
    confirmed: true,
    fetchImpl: fakeFetch(html)
  });
  assert.equal(result.ok, true);
  assert.equal(result.fetched.length, 1);
  assert.equal(result.citations[0].title, "Learning Source");

  const saveBlocked = saveRemoteSourcesToResourceInbox(vault, result);
  assert.equal(saveBlocked.requiresConfirmation, true);

  const saved = saveRemoteSourcesToResourceInbox(vault, result, { confirmed: true });
  assert.equal(saved.saved, true);
  assert.equal(saved.captured, 1);
  assert.equal(resourceInbox(vault)[0].title, "Learning Source");
});

test("remoteResearch search requires an injected provider", async () => {
  const { vault } = makeVault();
  const withoutProvider = await remoteResearch(vault, { query: "latest AI", explicitUserRequest: true });
  assert.equal(withoutProvider.requiresSearchProvider, true);

  const withProvider = await remoteResearch(vault, { query: "latest AI", explicitUserRequest: true }, {
    searchProvider: async () => [{ title: "AI result", url: "https://example.com/ai", snippet: "A result" }]
  });
  assert.equal(withProvider.ok, true);
  assert.equal(withProvider.searchResults.length, 1);
  assert.equal(withProvider.citations[0].title, "AI result");
});
