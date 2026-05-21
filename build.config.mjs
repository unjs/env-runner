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
  entries: [{ type: "bundle", input }],
});
