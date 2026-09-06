import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
const observabilityPreload = readFileSync(
  resolve(repoRoot, "observability.mjs"),
  "utf8",
);

test("preloads the shared runtime before React Router with the messaging profile", () => {
  assert.match(
    packageJson.scripts.start,
    /^node --import \.\/observability\.mjs .*react-router\/serve\/bin\.cjs/,
  );
  assert.equal(
    packageJson.dependencies["@modainteract/moda-interact-shared"],
    "0.6.2",
  );
  assert.match(
    observabilityPreload,
    /@modainteract\/moda-interact-shared\/observability\/node/,
  );
  assert.match(observabilityPreload, /serviceName: "moda-interact-messaging"/);
  assert.match(
    observabilityPreload,
    /instrument: \{ http: true, fetch: true, prisma: false \}/,
  );
});

test("packages the observability preload in the final production image", () => {
  const finalStage = dockerfile.split(/^FROM /m).at(-1);

  assert.match(finalStage, /COPY \.\/observability\.mjs \/app\/observability\.mjs/);
  assert.match(finalStage, /WORKDIR \/app/);
  assert.match(finalStage, /CMD \["npm", "run", "start"\]/);
});

test("keeps local and test hosted export disableable", () => {
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      "./observability.mjs",
      "--input-type=module",
      "--eval",
      [
        'import { getNodeObservabilityRuntime } from "@modainteract/moda-interact-shared/observability/node";',
        "const runtime = getNodeObservabilityRuntime();",
        "console.log(JSON.stringify({ enabled: runtime?.enabled, serviceName: runtime?.serviceName, environment: runtime?.environment }));",
        "await runtime?.shutdown();",
      ].join(" "),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        OTEL_SDK_DISABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "",
      },
    },
  );

  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), {
    enabled: false,
    serviceName: "moda-interact-messaging",
    environment: "test",
  });
});