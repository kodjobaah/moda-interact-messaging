import assert from "node:assert/strict";
import { test } from "node:test";

import routes from "../app/routes.ts";

test("health and ready use distinct React Router route modules", () => {
  const health = routes.find((entry) => entry.path === "health");
  const ready = routes.find((entry) => entry.path === "ready");

  assert.ok(health, "health route must exist");
  assert.ok(ready, "ready route must exist");
  assert.notEqual(
    health.file,
    ready.file,
    "health and ready must not reuse one file-derived route id",
  );
});
