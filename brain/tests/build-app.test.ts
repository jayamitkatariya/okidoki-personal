import { expect, test } from "bun:test";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/build-app.sh");
const identity = resolve(import.meta.dir, "../../scripts/identity.sh");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>placeholder</string>
<key>CFBundleExecutable</key><string>placeholder</string>
<key>CFBundleName</key><string>placeholder</string>
</dict></plist>
`;

for (const fixture of [
  { name: "no certificate", output: "0 valid identities found\n", identity: "-", status: 0 },
  { name: "unavailable keychain", output: "", identity: "-", status: 1 },
  { name: "Developer ID", output: '1) abc "Developer ID Application: Fixture"\n', identity: "Developer ID Application: Fixture", status: 0 },
  { name: "Apple Development", output: '1) abc "Apple Development: Fixture"\n', identity: "Apple Development: Fixture", status: 0 },
]) {
  test(`app packaging completes with ${fixture.name}, under its own identity, with no keys bundled`, async () => {
    const root = await mkdtemp(join(tmpdir(), "okidoki-package-"));
    try {
      for (const dir of ["scripts", ".build/release", "Resources/Fonts", "build", "bin"]) {
        await mkdir(join(root, dir), { recursive: true });
      }
      await copyFile(script, join(root, "scripts/build-app.sh"));
      await copyFile(identity, join(root, "scripts/identity.sh"));
      for (const [path, content] of Object.entries({
        ".build/release/Okidoki": "fixture binary",
        "Resources/Info.plist": plist,
        "Resources/BrandMark.png": "fixture image",
        "Resources/Okidoki.entitlements": "fixture entitlements",
        "build/AppIcon.icns": "fixture icon",
        ".env": "ANTHROPIC_API_KEY=service-fixture\nCONVEX_DEPLOY_KEY=deploy-fixture\nVITE_CONVEX_URL=build-fixture\n",
        "bin/swift": "#!/bin/sh\nexit 0\n",
        "bin/pgrep": "#!/bin/sh\nexit 1\n",
        "bin/security": '#!/bin/sh\ncat "$OKIDOKI_SIGN_FIXTURE"\nexit "$OKIDOKI_SIGN_STATUS"\n',
        "bin/codesign": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OKIDOKI_SIGN_LOG"\n',
        "identities.txt": fixture.output,
      })) {
        await writeFile(join(root, path), content);
        if (path.startsWith("bin/")) await chmod(join(root, path), 0o755);
      }
      const process = Bun.spawn(["/bin/bash", join(root, "scripts/build-app.sh")], {
        cwd: root,
        env: {
          ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
          OKIDOKI_CODESIGN_IDENTITY: "", OKIDOKI_SCRATCH: ".build", OKIDOKI_APP_DIR: "build/Okidoki.app",
          OKIDOKI_SIGN_FIXTURE: join(root, "identities.txt"), OKIDOKI_SIGN_STATUS: String(fixture.status),
          OKIDOKI_SIGN_LOG: join(root, "sign.log"),
        },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain(`Signing with: ${fixture.identity}`);
      const app = join(root, "build/Okidoki.app/Contents");
      expect(await readFile(join(app, "MacOS/Okidoki"), "utf8")).toBe("fixture binary");
      // Bring your own key: a .env in the repo never ends up in the app.
      expect(await access(join(app, "Resources/service.env")).then(() => true, () => false)).toBe(false);
      const info = await readFile(join(app, "Info.plist"), "utf8");
      expect(info).toContain("<string>dev.okidoki.mac</string>");
      expect(info).toContain("<string>Okidoki</string>");
      expect(await readFile(join(root, "sign.log"), "utf8")).toContain(`--sign ${fixture.identity}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
