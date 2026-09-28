// @ts-nocheck -- JSX pragma `h` is compiled by the test plugins (no `--jsx` in tsconfig)
import { h } from "./h.ts";
import { Status, label } from "./dep.ts";

enum Kind {
  Page = "page",
}

declare const __GREETING__: string;

export default {
  fetch() {
    return Response.json(
      <div kind={Kind.Page}>
        {label(Status.Ok)}
        {__GREETING__}
      </div>,
    );
  },
};
