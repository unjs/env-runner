// Process workers (node/bun/deno-process) receive the runner data over IPC, not
// the env: Linux caps a single env string at 128 KiB (`spawn E2BIG`) and Windows
// the whole env block at ~32K chars, which `data.virtual` sources easily exceed.
//
//   1. worker → host: `{ event: "request-init-data" }` (sent after it listens)
//   2. host → worker: `{ event: "init-data", data: "<JSON>" }` (snapshotted at spawn)
//
// Listening before requesting means the reply can't arrive unobserved, and it is
// consumed before the entry's `ipc.onMessage` is wired. The data stays a JSON
// string so json and advanced channels alike keep `JSON.stringify()` semantics.

/** Worker: request the runner data from the host over IPC. */
export function receiveProcessData(): Promise<any> {
  return new Promise<string>((resolve) => {
    const onMessage = (message: any) => {
      if (message?.event === "init-data") {
        process.off("message", onMessage);
        resolve(message.data);
      }
    };
    process.on("message", onMessage);
    process.send!({ event: "request-init-data" });
  }).then((json) => JSON.parse(json));
}
