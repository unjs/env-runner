export default function orderFn(code, _id, meta) {
  globalThis.__transformCalls.push(
    `fn:${meta.moduleType}:${code.includes(": number") ? "typed" : "untyped"}`,
  );
}
