# Changelog


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

