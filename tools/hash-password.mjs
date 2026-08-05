#!/usr/bin/env node
// tools/hash-password.mjs — generate an AUTH_USERS entry for a staff member.
//
// The password is read from STDIN (never from argv, so it stays out of your
// shell history). Two ways to run it:
//
//   Interactive:   node tools/hash-password.mjs amaris@bhwmedical.org "Amaris Murray" admin
//                  Password: ••••••  (type it, press enter)
//
//   Piped:         printf '%s' 'the-password' | node tools/hash-password.mjs amaris@bhwmedical.org "Amaris Murray" admin
//
// It prints one JSON user object. Collect one per staff member into a JSON
// array and set that array as the AUTH_USERS environment variable in Netlify.
// Also set AUTH_SECRET (openssl rand -hex 32) to switch authentication on.

import { createRequire } from "node:module";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const { hashPassword } = require("../netlify/functions/lib/auth.js");

const [email, name, role] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node tools/hash-password.mjs <email> [name] [role]');
  process.exit(1);
}

function readPassword() {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Piped input — read it all, strip a single trailing newline.
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
      process.stdin.on("error", reject);
      return;
    }
    // Interactive TTY — prompt with the echo muted.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let muted = false;
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (!muted) orig(s); };
    process.stdout.write("Password: ");
    muted = true;
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const password = await readPassword();
if (!password || password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const user = {
  email: String(email).trim().toLowerCase(),
  name: name || email,
  role: role || "staff",
  hash: hashPassword(password),
};

console.log("\nAdd this object to the AUTH_USERS JSON array:\n");
console.log(JSON.stringify(user, null, 2));
console.log("\nExample AUTH_USERS value (array of one or more users):");
console.log(JSON.stringify([user]));
