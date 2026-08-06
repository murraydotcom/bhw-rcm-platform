#!/usr/bin/env node
// tools/make-auth-users.mjs — build a complete AUTH_USERS value in one step.
//
// Pass one arg per staff member as  email:Name:role  (role optional → staff).
// It prompts for each person's password (echo muted; leave BLANK for a
// Google-only account with no password), then prints the finished AUTH_USERS
// JSON to paste into Netlify. Passwords are hashed locally and never printed.
//
//   node tools/make-auth-users.mjs \
//     approved-admin@bhwmedical.org:"Approved Admin":admin \
//     approved-staff@bhwmedical.org:"Approved Staff":staff
//
// Entries with a password get a scrypt hash (password + Google login both work
// for that email). Entries left blank are Google-only but keep their role.

import { createRequire } from "node:module";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const { hashPassword } = require("../netlify/functions/lib/auth.js");

// Parse "email:Name with spaces:role" — split on the first and last colon so
// the name in the middle may itself be anything without a colon.
export function parseEntry(arg) {
  const first = arg.indexOf(":");
  if (first < 0) return { email: arg.trim().toLowerCase(), name: arg, role: "staff" };
  const last = arg.lastIndexOf(":");
  const email = arg.slice(0, first).trim().toLowerCase();
  if (last === first) return { email, name: arg.slice(first + 1) || email, role: "staff" };
  return { email, name: arg.slice(first + 1, last) || email, role: arg.slice(last + 1).trim() || "staff" };
}

// Turn a parsed entry + optional password into a stored user record.
export function toUser({ email, name, role }, password) {
  const u = { email, name, role };
  if (password) u.hash = hashPassword(password);
  return u;
}

function promptPassword(rl, label) {
  return new Promise((resolve) => {
    let muted = false;
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (!muted) orig(s); };
    process.stdout.write(label);
    muted = true;
    rl.question("", (answer) => { process.stdout.write("\n"); rl._writeToOutput = orig; resolve(answer); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node tools/make-auth-users.mjs email:"Name":role [email:"Name":role ...]');
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error("This tool is interactive — run it in a terminal so passwords can be typed securely.");
    process.exit(1);
  }
  const entries = args.map(parseEntry);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const users = [];
  for (const e of entries) {
    const pw = await promptPassword(rl, `Password for ${e.email} (blank = Google-only): `);
    if (pw && pw.length < 8) { console.error("  ✗ too short (min 8) — skipping password for this user; they’ll be Google-only."); users.push(toUser(e)); continue; }
    users.push(toUser(e, pw || undefined));
  }
  rl.close();

  console.log("\nSet this as the AUTH_USERS environment variable in Netlify:\n");
  console.log(JSON.stringify(users));
  console.log("\n(pretty, for reference — paste the single line above)\n");
  console.log(JSON.stringify(users, null, 2));
}

// Only run the CLI when invoked directly (keeps the helpers importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) main();
