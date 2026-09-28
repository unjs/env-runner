import { resolveRuntimeDep } from "../common/runtime-deps.ts";
import type { EnvRunnerPlugin, SourceMapLike } from "../common/plugin.ts";

interface OxcTransformModule {
  transformSync(
    filename: string,
    code: string,
    options?: object,
  ): {
    code: string;
    map?: SourceMapLike;
    errors: { severity: string; message: string; codeframe: string | null }[];
  };
}

/**
 * TypeScript/JSX plugin using `oxc-transform` (installed by the app, imported
 * from cwd). Only TypeScript/JSX modules are compiled (plain JS is left alone).
 * Options are passed as-is to its `transformSync()`, with `sourcemap: true`
 * and `lang` (the module type) as defaults.
 *
 * ```ts
 * plugins: [["env-runner/plugins/oxc", { jsx: { runtime: "automatic" } }]]
 * ```
 */
export default async function oxc(options: Record<string, unknown> = {}): Promise<EnvRunnerPlugin> {
  const mod = await resolveRuntimeDep<OxcTransformModule>({
    name: "oxc-transform",
    option: "plugins",
    expect: "transformSync",
  });
  if (!mod) {
    throw new Error(
      "the `oxc-transform` package is required by `env-runner/plugins/oxc`: install it in your app",
    );
  }
  return {
    name: "oxc",
    transform: {
      filter: { moduleType: ["ts", "tsx", "jsx"] },
      handler(code, id, { moduleType }) {
        const result = mod.transformSync(id, code, {
          sourcemap: true,
          lang: moduleType,
          ...options,
        });
        const errors = result.errors.filter((error) => error.severity === "Error");
        if (errors.length > 0) {
          throw new SyntaxError(
            `[env-runner] failed to transform "${id}":\n` +
              errors.map((error) => error.codeframe || error.message).join("\n"),
          );
        }
        return { code: result.code, map: result.map, moduleType: "js" };
      },
    },
  };
}
