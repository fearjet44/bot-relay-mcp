import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { authenticateBot, extractBotToken, extractViewerToken, sha256, tokenMatchesHash } from "../src/auth.ts";
import { botIds, ConfigError, loadConfig, parseBots } from "../src/config.ts";
import { TOKENS, testEnv } from "./helpers.ts";

describe("config", () => {
  it("parses BOTS id:sha256 pairs", () => {
    const config = loadConfig(testEnv());
    assert.deepEqual(
      config.bots.map((b) => b.id),
      ["chief-of-staff", "abjets-company", "intruder"],
    );
    assert.equal(config.bots[0]!.tokenHash.toString("hex"), sha256(TOKENS["chief-of-staff"]).toString("hex"));
    assert.equal(config.port, 8080);
    assert.equal(config.dbPath, "/data/relay.db");
    assert.equal(config.maxBodyBytes, 32 * 1024);
  });

  it("allows BOTS to be omitted for zero-config DB mode, and rejects malformed or duplicate entries", () => {
    const h = sha256("x").toString("hex");
    assert.deepEqual(parseBots(undefined), []);
    assert.deepEqual(parseBots(""), []);
    assert.throws(() => parseBots(","), ConfigError);
    assert.throws(() => parseBots("chief-of-staff"), ConfigError);
    assert.throws(() => parseBots("chief-of-staff:nothex"), ConfigError);
    assert.throws(() => parseBots(`Bad_Id:${h}`), ConfigError);
    assert.throws(() => parseBots(`a:${h},b:${h}`), ConfigError);
  });

  it("allows two hashes for one bot id so tokens can be rotated without downtime", () => {
    const oldToken = "relay_old";
    const newToken = "relay_new";
    const config = loadConfig({
      BOTS: `a:${sha256(oldToken).toString("hex")},a:${sha256(newToken).toString("hex")},b:${sha256("b").toString("hex")}`,
    });
    assert.deepEqual(botIds(config), ["a", "b"]);
    assert.equal(authenticateBot(config.bots, oldToken), "a");
    assert.equal(authenticateBot(config.bots, newToken), "a");
  });

  it("does not accept a plaintext viewer token in place of its hash", () => {
    assert.throws(() => loadConfig(testEnv({ VIEWER_TOKEN_SHA256: "plaintext-token" })), ConfigError);
  });
});

describe("bot authentication", () => {
  const { bots } = loadConfig(testEnv());

  it("derives the bot id from the token", () => {
    assert.equal(authenticateBot(bots, TOKENS["chief-of-staff"]), "chief-of-staff");
    assert.equal(authenticateBot(bots, TOKENS["abjets-company"]), "abjets-company");
  });

  it("rejects missing, wrong, oversized and hash-instead-of-token values", () => {
    assert.equal(authenticateBot(bots, undefined), undefined);
    assert.equal(authenticateBot(bots, ""), undefined);
    assert.equal(authenticateBot(bots, "relay_wrong"), undefined);
    assert.equal(authenticateBot(bots, `${TOKENS["chief-of-staff"]}x`), undefined);
    assert.equal(authenticateBot(bots, "a".repeat(10_000)), undefined);
    assert.equal(authenticateBot(bots, sha256(TOKENS["chief-of-staff"]).toString("hex")), undefined);
  });

  it("reads Authorization: Bearer and prefers X-Relay-Token", () => {
    assert.equal(extractBotToken({ authorization: "Bearer abc" }), "abc");
    assert.equal(extractBotToken({ authorization: "bearer   abc " }), "abc");
    assert.equal(extractBotToken({ authorization: "Basic abc" }), undefined);
    assert.equal(extractBotToken({}), undefined);
    assert.equal(
      extractBotToken({ authorization: '{"cf-access-client-id":"x"}', "x-relay-token": "relay_tok" }),
      "relay_tok",
    );
  });

  it("reads the viewer token from Bearer or Basic auth", () => {
    const hash = sha256("viewer-secret");
    const basic = `Basic ${Buffer.from("justin:viewer-secret").toString("base64")}`;
    assert.equal(extractViewerToken({ authorization: basic }), "viewer-secret");
    assert.equal(tokenMatchesHash(extractViewerToken({ authorization: basic }), hash), true);
    assert.equal(tokenMatchesHash(extractViewerToken({ authorization: "Bearer viewer-secret" }), hash), true);
    assert.equal(tokenMatchesHash(extractViewerToken({ authorization: "Bearer nope" }), hash), false);
    assert.equal(tokenMatchesHash(undefined, hash), false);
  });
});

describe("hash-token script", () => {
  it("prints a token whose SHA-256 matches the printed hash", () => {
    const out = execFileSync(process.execPath, ["scripts/hash-token.mjs", "chief-of-staff"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = out.match(/^TOKEN\s+(\S+)$/m)?.[1];
    const hash = out.match(/^SHA256\s+([0-9a-f]{64})$/m)?.[1];
    assert.ok(token?.startsWith("relay_"));
    assert.equal(hash, sha256(token!).toString("hex"));
    assert.match(out, new RegExp(`^BOTS entry\\s+chief-of-staff:${hash}$`, "m"));
  });

  it("hashes a token from stdin", () => {
    const out = execFileSync(process.execPath, ["scripts/hash-token.mjs", "--stdin"], {
      encoding: "utf8",
      input: "relay_existing\n",
    });
    assert.equal(out.trim(), sha256("relay_existing").toString("hex"));
  });
});
