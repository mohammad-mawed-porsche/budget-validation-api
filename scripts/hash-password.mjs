import { hash } from "argon2";

const password = process.argv[2];
if (!password || Buffer.byteLength(password, "utf8") > 1024) {
  console.error("Usage: npm run auth:hash-password -- '<password up to 1024 bytes>'");
  process.exit(1);
}

console.log(await hash(password, { type: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1 }));
