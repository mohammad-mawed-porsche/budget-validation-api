import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const output = resolve(project, ".lambda");

mkdirSync(resolve(output, "node_modules", "@phc"), { recursive: true });
cpSync(resolve(project, "node_modules", "argon2"), resolve(output, "node_modules", "argon2"), { recursive: true });
cpSync(resolve(project, "node_modules", "node-gyp-build"), resolve(output, "node_modules", "node-gyp-build"), { recursive: true });
cpSync(resolve(project, "node_modules", "@phc", "format"), resolve(output, "node_modules", "@phc", "format"), { recursive: true });
writeFileSync(resolve(output, "package.json"), `${JSON.stringify({ type: "commonjs", private: true }, null, 2)}\n`, { mode: 0o600 });

const linuxArgon2 = resolve(output, "node_modules", "argon2", "prebuilds", "linux-x64", "argon2.glibc.node");
if (!existsSync(linuxArgon2)) throw new Error("The Lambda package is missing the Linux x64 Argon2 binary.");
