import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import path from "node:path";

import { after, test } from "node:test";

import { removeCreatedTrees, ROOT } from "./helpers/server.ts";

after(removeCreatedTrees);

// docker-compose.yml は env_file を使わず、渡す変数を列挙している。
// サーバーが読む変数を足したのに compose に書き忘れると、.env に書いても黙って効かないため確かめる
test("サーバーが読む環境変数は、docker-compose.yml からコンテナーに渡している", () => {
  const envSource = readFileSync(path.join(ROOT, "src", "config", "env.ts"), "utf8");

  const read = new Set([
    ...[...envSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1] ?? ""),
    ...[...envSource.matchAll(/toInt\("([A-Z0-9_]+)"/g)].map((m) => m[1] ?? ""),
  ]);

  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

  const environment = compose.slice(compose.indexOf("environment:"), compose.indexOf("volumes:"));

  const forwarded = new Set(
    [...environment.matchAll(/^\s+([A-Z0-9_]+):/gm)].map((m) => m[1] ?? ""),
  );

  // コンテナーの中では待ち受けの場所を固定しているため、PORT と HOST は渡さない
  const notForwarded = new Set(["PORT", "HOST"]);

  const missing = [...read].filter((name) => !forwarded.has(name) && !notForwarded.has(name));

  assert.ok(read.size > 5, `found only ${read.size} variables in env.ts`);

  assert.deepEqual(missing, []);
});

// Dockerfile は COPY . . で文脈をまるごと写す。.gitignore で外している秘密のファイルが
// .dockerignore に無いと、手元にあるだけでイメージの層に入る
test(".gitignore で外している秘密のファイルは、Docker のビルドの文脈からも外している", () => {
  const lines = (file: string) =>
    readFileSync(path.join(ROOT, file), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  const dockerignore = new Set(lines(".dockerignore"));

  for (const pattern of [".env", ".env.*", ".npmrc"]) {
    assert.ok(lines(".gitignore").includes(pattern), `.gitignore should list ${pattern}`);

    assert.ok(dockerignore.has(pattern), `.dockerignore should list ${pattern}`);
  }

  // 試験はイメージの中では動かさないため、写さない
  assert.ok(dockerignore.has("test"));
});

const composeText = () => readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

// "C:\dev\claude=/work/dev/claude" を、ホストの側とコンテナーの側に分ける。区切りの向きはそろえる
function splitRoot(value: string): { host: string; container: string } {
  const [host = "", container = ""] = value.split("=");

  return { host: host.replace(/\\/g, "/").toLowerCase(), container };
}

test("コンテナーは権限を絞って動かす", () => {
  const compose = composeText();

  assert.match(compose, /^\s+read_only: true$/m);

  assert.match(compose, /^\s+tmpfs:\n\s+- \/tmp$/m);

  assert.match(compose, /^\s+cap_drop:\n\s+- ALL$/m);

  assert.match(compose, /^\s+- no-new-privileges:true$/m);

  assert.match(compose, /^\s+pids_limit: \d+$/m);
});

test("C:/dev は読み取り専用にし、書き込み先だけを読み書きできる形で重ねる", () => {
  const compose = composeText();

  const volumes = compose.slice(compose.indexOf("volumes:"), compose.indexOf("healthcheck:"));

  const mounts = [...volumes.matchAll(/^\s+- ([^\s#]+)$/gm)].map((m) => m[1] ?? "");

  assert.ok(mounts.includes("C:/dev:/work/dev:ro"), `C:/dev must be read-only: ${mounts.join(", ")}`);

  // 既定の CLONE_ROOT と、.env.example の OUTPUT_DIR の例が指す場所を、読み書きできる形でマウントしていること
  const cloneDefault = /CLONE_ROOT: \$\{CLONE_ROOT:-([^}]+)\}/.exec(compose)?.[1] ?? "";

  const envExample = readFileSync(path.join(ROOT, ".env.example"), "utf8");

  const outputExample = /^# OUTPUT_DIR=(.+)$/m.exec(envExample)?.[1] ?? "";

  for (const value of [cloneDefault, outputExample]) {
    const { host, container } = splitRoot(value);

    assert.ok(container, `could not read the container path from "${value}"`);

    const mount = mounts.find((m) => m.endsWith(`:${container}`) || m.endsWith(`:${container}:ro`));

    assert.ok(mount, `${container} is not mounted`);

    assert.ok(!mount.endsWith(":ro"), `${container} must be writable: ${mount}`);

    assert.equal(mount.slice(0, -`:${container}`.length).toLowerCase(), host, mount);
  }
});

test("CI はコンテナーを docker-compose.yml と同じ絞り込みで起動する", () => {
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

  const run = /docker run --detach[\s\S]*?"\$\{IMAGE\}"/.exec(ci)?.[0] ?? "";

  const pids = /^\s+pids_limit: (\d+)$/m.exec(composeText())?.[1];

  for (const flag of ["--read-only", "--tmpfs /tmp", "--cap-drop ALL", "--security-opt no-new-privileges", `--pids-limit ${pids}`]) {
    assert.ok(run.includes(flag), `ci.yml docker run is missing ${flag}`);
  }
});

test("監査ログは FILE_ROOTS の外の名前付きボリュームに書く", () => {
  const compose = composeText();

  const dir = /AUDIT_LOG_DIR: \$\{AUDIT_LOG_DIR:-([^}]+)\}/.exec(compose)?.[1] ?? "";

  assert.ok(dir.startsWith("/"), `AUDIT_LOG_DIR default should be an absolute container path: "${dir}"`);

  // 名前付きボリュームをその場所にマウントし、トップレベルで宣言していること
  const mount = new RegExp(`^\\s+- ([a-z0-9-]+):${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(compose);

  assert.ok(mount, `no named volume is mounted at ${dir}`);

  assert.match(compose, new RegExp(`^volumes:\\n\\s+${mount[1]}:`, "m"));

  // ファイルのツールから読めない場所であること
  const roots = /FILE_ROOTS: '([^']+)'/.exec(compose)?.[1] ?? "";

  for (const root of roots.split(";")) {
    const container = root.split("=")[1] ?? "";

    assert.ok(container && !dir.startsWith(`${container}/`) && dir !== container, `${dir} is inside FILE_ROOTS (${root})`);
  }
});
