import { hash } from "argon2";

if (process.argv.length > 2 || process.stdin.isTTY) {
  console.error("Read a password with a hidden shell prompt, then pipe it to this command via stdin. Do not pass passwords as arguments.");
  process.exit(1);
}

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 1024) {
    console.error("Password must not exceed 1024 UTF-8 bytes.");
    process.exit(1);
  }
  chunks.push(chunk);
}
const password = Buffer.concat(chunks).toString("utf8");
if (!password) {
  console.error("Password cannot be empty.");
  process.exit(1);
}
console.log(await hash(password, { type: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1 }));
