#!/usr/bin/env node
// Generates a random relay token and prints it ONCE together with its SHA-256.
// Only the hash goes into .env; the token goes into the bot's connector config.
//
//   npm run hash-token                     # new token + hash
//   npm run hash-token -- chief-of-staff   # same, plus a ready-made BOTS entry
//   npm run hash-token -- --stdin < file   # hash an existing token (prints hash only)
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: hash-token [bot-id] | hash-token --stdin");
  process.exit(0);
}

if (args.includes("--stdin")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const token = input.trim();
  if (!token) {
    console.error("no token on stdin");
    process.exit(1);
  }
  console.log(sha256(token));
  process.exit(0);
}

const botId = args.find((a) => !a.startsWith("-"));
if (botId && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(botId)) {
  console.error("bot id must be lowercase letters, digits and dashes (max 63 chars)");
  process.exit(1);
}

const token = `relay_${randomBytes(32).toString("base64url")}`;
const hash = sha256(token);

console.error("Shown once. Put the TOKEN only into the bot's connector secret storage;");
console.error("never paste it into a chat, issue, PR, or log. Only the HASH belongs in .env.\n");
console.log(`TOKEN  ${token}`);
console.log(`SHA256 ${hash}`);
if (botId) console.log(`BOTS entry  ${botId}:${hash}`);
