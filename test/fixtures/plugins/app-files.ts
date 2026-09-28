// @ts-nocheck -- Bun-native file types, one transformed by a plugin
import note from "./note.txt" with { type: "text" };
import logo from "./logo.svg";
import yaml from "./data.yaml";

export default {
  fetch: () => Response.json({ note: note.trim(), logo: logo.split(/[\\/]/).pop(), yaml }),
};
