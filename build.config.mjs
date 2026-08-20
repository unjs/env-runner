import { defineBuildConfig } from "obuild/config";
import pkg from "./package.json" with { type: "json" };

const input = Object.entries(pkg.exports).map(([exportPath]) => {
  if (exportPath === ".") {
    return "src/index.ts";
  }
  if (exportPath.startsWith("./runners/")) {
    // ./runners/<name>          => src/runners/<name>/runner.ts
    // ./runners/<name>/<sub>    => src/runners/<name>/<sub>.ts
    const parts = exportPath.slice(2).split("/");
    const name = parts[1];
    const file = parts[2] || "runner";
    return `src/runners/${name}/${file}.ts`;
  }
  // ./<path> => src/<path>.ts
  return `src/${exportPath.slice(2)}.ts`;
});

input.push("src/cli.ts");

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input,
      // Not dependencies (nor peer dependencies): runners take these as
      // explicit options and only fall back to an optional dynamic import
      // resolved from the user's project. Keep them external so they are never
      // inlined into `dist`.
      rolldown: {
        external: ["miniflare", "wrangler", "@netlify/runtime", "@vercel/queue"],
      },
    },
  ],
  hooks: {
    rolldownOutput(cfg) {
      cfg.chunkFileNames = (chunk) => {
        // Name shared chunks after their source module path instead of the
        // basename (multiple `runner.ts` entries otherwise collide into
        // `runner.mjs`, `runner2.mjs`, ...)
        const moduleId = chunk.facadeModuleId || chunk.moduleIds.at(-1) || "";
        const srcPath = moduleId.split(/[/\\]src[/\\]/)[1];
        if (!srcPath) {
          return "_chunks/[name].mjs"; // node_modules libs, etc.
        }
        const name = srcPath
          .replace(/(\.d)?\.[mc]?ts$/, "")
          .replace(/^runners[/\\]/, "")
          .replace(/[/\\]/g, "-");
        return `_chunks/${name}.mjs`;
      };
    },
  },
});
