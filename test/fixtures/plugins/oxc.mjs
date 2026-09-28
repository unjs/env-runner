// A TypeScript/JSX plugin with `oxc-transform`. Only TS/JSX modules reach it
// (`moduleType`), optionally scoped further by an `id` filter from the options.
import { transformSync } from "oxc-transform";

export default ({ id, ...options } = {}) => ({
  name: "oxc",
  transform: {
    filter: { moduleType: ["ts", "tsx", "jsx"], ...(id && { id }) },
    handler(code, path, { moduleType }) {
      const result = transformSync(path, code, { sourcemap: true, lang: moduleType, ...options });
      const errors = result.errors.filter((error) => error.severity === "Error");
      if (errors.length > 0) {
        throw new SyntaxError(
          `failed to transform "${path}":\n` +
            errors.map((error) => error.codeframe || error.message).join("\n"),
        );
      }
      return { code: result.code, map: result.map, moduleType: "js" };
    },
  },
});
