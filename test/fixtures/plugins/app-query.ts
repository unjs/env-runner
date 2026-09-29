// @ts-nocheck -- imports with a query, loaded or transformed by plugins
import note from "./note.txt?raw";
import depSource from "./dep.ts?raw";
import depLines from "./dep.ts?lines";
import * as dep from "./dep.ts";
import * as depRaw from "./dep.ts?raw";
import cjs from "./cjs/lib.ts?cjs";
import stamp from "#stamp";

export default {
  fetch: async () =>
    Response.json({
      note: note.trim(),
      depSource: depSource.includes("export enum Status"),
      depLines,
      label: dep.label(dep.Status.Ok),
      // `./dep.ts` and `./dep.ts?raw` are separate modules.
      separate: dep !== depRaw && depRaw.default === depSource && !("label" in depRaw),
      dynamic: (await import("./dep.ts?raw")).default === depSource,
      cjs: cjs.value,
      stamp,
    }),
};
