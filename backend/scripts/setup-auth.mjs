// Generates Convex Auth signing keys and sets them on the deployment in .env.local, without printing the private key.
// Run from backend/: npm run setup-auth -- [panel-url]   (default http://127.0.0.1:5174)
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const { exportJWK, exportPKCS8, generateKeyPair } = require("jose");
const siteUrl = process.argv[2] ?? "http://127.0.0.1:5174";

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " ");
const jwks = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });

const cli = join(process.cwd(), "node_modules", "convex", "bin", "main.js");
const set = (name, value) => {
  execFileSync(process.execPath, [cli, "env", "set", name, "--", value], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`set ${name}`);
};
set("JWT_PRIVATE_KEY", privateKey);
set("JWKS", jwks);
set("SITE_URL", siteUrl);
