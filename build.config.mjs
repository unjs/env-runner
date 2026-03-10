import { defineBuildConfig } from "obuild/config";
import pkg from "./package.json" with { type: "json" };

const input = Object.entries(pkg.exports).map(([exportPath]) => {
  if (exportPath === ".") {
    return "src/index.ts";
  }
  // ./runners/<name> => src/runners/<name>/runner.ts
  // ./runners/<name>/worker => src/runners/<name>/worker.ts
  const parts = exportPath.slice(2).split("/");
  const name = parts[1];
  const file = parts[2] === "worker" ? "worker" : "runner";
  return `src/runners/${name}/${file}.ts`;
});

input.push("src/cli.ts");

export default defineBuildConfig({
  entries: [{ type: "bundle", input }],
});
