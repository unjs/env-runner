import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Simulates an entry with a slow top-level import (e.g. opening DB pools).
// Marker files let the orphan test observe whether the import survived the
// supervisor's death (test/orphan.test.ts).
const markerDir = process.env.ORPHAN_TEST_MARKER_DIR;
writeFileSync(join(markerDir, "import-started"), String(process.pid));
await new Promise((r) => setTimeout(r, 3000));
writeFileSync(join(markerDir, "import-finished"), String(process.pid));

export default {
  fetch() {
    return new Response(String(process.pid));
  },
};
