# Changelog


## v0.2.1

[compare changes](https://github.com/unjs/env-runner/compare/v0.2.0...v0.2.1)

### 🚀 Enhancements

- Propagate host terminal capabilities to workers ([1c4c7f6](https://github.com/unjs/env-runner/commit/1c4c7f6))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.2.0

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.16...v0.2.0)

### 🚀 Enhancements

- ⚠️  Require explicit runtime deps ([dbc9cbb](https://github.com/unjs/env-runner/commit/dbc9cbb))

### 🏡 Chore

- Update deps ([7fef0a6](https://github.com/unjs/env-runner/commit/7fef0a6))

#### ⚠️ Breaking Changes

- ⚠️  Require explicit runtime deps ([dbc9cbb](https://github.com/unjs/env-runner/commit/dbc9cbb))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.16

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.15...v0.1.16)

### 🚀 Enhancements

- Runtime-native WebSocket upgrade proxying ([#33](https://github.com/unjs/env-runner/pull/33))

### ❤️ Contributors

- Pi0x <x@pi0.io>

## v0.1.15

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.14...v0.1.15)

### 🩹 Fixes

- **virtual:** Serve Deno virtual modules as plain ESM format ([c5bfcd3](https://github.com/unjs/env-runner/commit/c5bfcd3))
- **node-worker,node-process:** Use native crossws adapter on bun/deno ([d8ce2be](https://github.com/unjs/env-runner/commit/d8ce2be))

### 🏡 Chore

- **release:** V0.1.14 ([2d7d17e](https://github.com/unjs/env-runner/commit/2d7d17e))
- Split agent docs ([4079f03](https://github.com/unjs/env-runner/commit/4079f03))
- Update deps ([a11bf03](https://github.com/unjs/env-runner/commit/a11bf03))

### ✅ Tests

- **wrangler:** Mock a local indirection to force the fallback reader ([1f09e18](https://github.com/unjs/env-runner/commit/1f09e18))
- Raise timeouts for runtime cold starts ([283bdae](https://github.com/unjs/env-runner/commit/283bdae))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.14

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.13...v0.1.14)

### 🚀 Enhancements

- **miniflare:** Support optionally loading wrangler config ([#28](https://github.com/unjs/env-runner/pull/28))

### ❤️ Contributors

- Pi0x <x@pi0.io>

## v0.1.13

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.12...v0.1.13)

### 🩹 Fixes

- **upgrade:** Handle rejected websocket upgrades without crashing ([0558ae0](https://github.com/unjs/env-runner/commit/0558ae0))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.12

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.11...v0.1.12)

### 🩹 Fixes

- **virtual:** Resolve bare/relative imports from virtual modules against cwd ([4f28877](https://github.com/unjs/env-runner/commit/4f28877))

### 📦 Build

- Better chunk names ([bab0d09](https://github.com/unjs/env-runner/commit/bab0d09))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.11

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.10...v0.1.11)

### 🚀 Enhancements

- **server:** Support `reload()` without arguments to create a fresh runner ([322e5e4](https://github.com/unjs/env-runner/commit/322e5e4))
- `invalidateModule` for virtuals ([00d99a6](https://github.com/unjs/env-runner/commit/00d99a6))
- Support relative fetch ([b69598f](https://github.com/unjs/env-runner/commit/b69598f))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.10

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.9...v0.1.10)

### 🚀 Enhancements

- Virtual imports ([#26](https://github.com/unjs/env-runner/pull/26))
- Default env server runner to `node-worker` ([4744002](https://github.com/unjs/env-runner/commit/4744002))
- Implement async disposable ([1ec6f29](https://github.com/unjs/env-runner/commit/1ec6f29))
- **server:** Auto start on first fetch ([bf37885](https://github.com/unjs/env-runner/commit/bf37885))

### 🩹 Fixes

- **node-process, bun-process:** Exit worker on IPC disconnect to avoid orphans ([#24](https://github.com/unjs/env-runner/pull/24))
- **node-process, bun-process:** Register disconnect handler before entry import ([838b252](https://github.com/unjs/env-runner/commit/838b252))
- Forward child stdio for process runners ([#25](https://github.com/unjs/env-runner/pull/25))

### 🏡 Chore

- Update deps ([af647ed](https://github.com/unjs/env-runner/commit/af647ed))

### ✅ Tests

- Fake oidc token ([3e9fac7](https://github.com/unjs/env-runner/commit/3e9fac7))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>
- Ou ([@ourongxing](https://github.com/ourongxing))
- Saba Tchikhinashvili ([@saba-ch](https://github.com/saba-ch))

## v0.1.9

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.8...v0.1.9)

### 💅 Refactors

- Simplify vercel oidc token warns ([02a87a5](https://github.com/unjs/env-runner/commit/02a87a5))

### ❤️ Contributors

- Pooya Parsa <x@pi0.io>

## v0.1.8

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.7...v0.1.8)

### 🚀 Enhancements

- **vercel:** Add env vars, `x-vercel-id` header, and response headers ([caa3625](https://github.com/unjs/env-runner/commit/caa3625))
- **vercel:** Vercel queues ([#16](https://github.com/unjs/env-runner/pull/16))
- **vercel:** Prompt to update oidc token if unset/expired ([#15](https://github.com/unjs/env-runner/pull/15))

### 🏡 Chore

- Update deps ([4b5d42f](https://github.com/unjs/env-runner/commit/4b5d42f))
- Update deps ([faf2f21](https://github.com/unjs/env-runner/commit/faf2f21))

### ❤️ Contributors

- Rihan Arfan ([@RihanArfan](https://github.com/RihanArfan))
- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.7

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.6...v0.1.7)

### 🚀 Enhancements

- Support custom export conditions ([#5](https://github.com/unjs/env-runner/pull/5))
- **vercel:** Add vercel runner ([#3](https://github.com/unjs/env-runner/pull/3))
- Netlify runner ([7e47106](https://github.com/unjs/env-runner/commit/7e47106))
- **vercel:** Shim full `@vercel/request-context` for `@vercel/functions` compat ([cb9a358](https://github.com/unjs/env-runner/commit/cb9a358))

### 🩹 Fixes

- **miniflare:** Pass through cloudflare:* imports to workerd ([#6](https://github.com/unjs/env-runner/pull/6))
- **deno:** Use stdin/stdout IPC and prevent `deno.lock` creation ([1df4340](https://github.com/unjs/env-runner/commit/1df4340))

### 📖 Documentation

- Add vercel runner to AGENTS.md ([586bf30](https://github.com/unjs/env-runner/commit/586bf30))

### 🏡 Chore

- Update deps ([6583926](https://github.com/unjs/env-runner/commit/6583926))
- Apply automated updates ([ee3dd7c](https://github.com/unjs/env-runner/commit/ee3dd7c))

### ✅ Tests

- Add rpc() method coverage across all runners ([#4](https://github.com/unjs/env-runner/pull/4))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Rihan Arfan ([@RihanArfan](https://github.com/RihanArfan))
- Ori ([@oritwoen](https://github.com/oritwoen))

## v0.1.6

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.5...v0.1.6)

### 🚀 Enhancements

- **manager:** Replace callback properties with multi-listener event pattern ([76d8cda](https://github.com/unjs/env-runner/commit/76d8cda))

### 💅 Refactors

- Remove graceful shutdowns ([6e969b1](https://github.com/unjs/env-runner/commit/6e969b1))

### 🏡 Chore

- Update lock ([5c5ae67](https://github.com/unjs/env-runner/commit/5c5ae67))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.5

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.4...v0.1.5)

### 🩹 Fixes

- **miniflare:** Serve CJS modules with an ESM shim wrapper ([18acd21](https://github.com/unjs/env-runner/commit/18acd21))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.4

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.3...v0.1.4)

### 🩹 Fixes

- Windows imports ([e41f7af](https://github.com/unjs/env-runner/commit/e41f7af))
- Import fresh on module reload ([bb997d0](https://github.com/unjs/env-runner/commit/bb997d0))

### 🤖 CI

- Windows and macos tests ([2c925bb](https://github.com/unjs/env-runner/commit/2c925bb))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.3

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- Worker upgrade support ([ddbd543](https://github.com/unjs/env-runner/commit/ddbd543))
- Crossws support ([d8252c3](https://github.com/unjs/env-runner/commit/d8252c3))
- Support crossws for miniflare ([851bb31](https://github.com/unjs/env-runner/commit/851bb31))

### 🩹 Fixes

- **cf:** Use service binding ipc ([5f71e71](https://github.com/unjs/env-runner/commit/5f71e71))

### 🏡 Chore

- **release:** V0.1.2 ([666978e](https://github.com/unjs/env-runner/commit/666978e))
- Apply automated updates ([7a0a675](https://github.com/unjs/env-runner/commit/7a0a675))

### ❤️ Contributors

- Pooya Parsa <pooya@pi0.io>

## v0.1.2

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- Vite env api compat ([94ab889](https://github.com/unjs/env-runner/commit/94ab889))
- `runner.reloadModule` ([1faeb7d](https://github.com/unjs/env-runner/commit/1faeb7d))
- **miniflare:** Support transformRequest ([acf16ae](https://github.com/unjs/env-runner/commit/acf16ae))
- Miniflare improvements ([0d1064c](https://github.com/unjs/env-runner/commit/0d1064c))
- Worker upgrade support ([ddbd543](https://github.com/unjs/env-runner/commit/ddbd543))

### 🩹 Fixes

- **miniflare:** Use temp dir ([5d44bec](https://github.com/unjs/env-runner/commit/5d44bec))
- **miniflare:** Resolve wrapper imports relative to entry ([d1efa65](https://github.com/unjs/env-runner/commit/d1efa65))
- **miniflare:** Handle `file://` ([493071f](https://github.com/unjs/env-runner/commit/493071f))
- **miniflare:** Standard response ([f3acb23](https://github.com/unjs/env-runner/commit/f3acb23))

### 💅 Refactors

- Improve miniflare runner ([de0934d](https://github.com/unjs/env-runner/commit/de0934d))
- **miniflare:** Use ws pair for rpc ([0a4009b](https://github.com/unjs/env-runner/commit/0a4009b))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.1

[compare changes](https://github.com/unjs/env-runner/compare/v0.1.0...v0.1.1)

### 🩹 Fixes

- **bun, deno:** Spawning issues ([f6ade77](https://github.com/unjs/env-runner/commit/f6ade77))

### 💅 Refactors

- **miniflare:** Default compat date to latest ([9996f87](https://github.com/unjs/env-runner/commit/9996f87))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

