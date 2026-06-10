// Imports a virtual module registered via the runner's `data.virtual` map.
import { message } from "#virtual-message";

export default {
  fetch() {
    return new Response(message);
  },
};
