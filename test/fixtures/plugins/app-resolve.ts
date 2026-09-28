// @ts-nocheck -- modules from the plugins' `resolveId`/`load` hooks
import message from "virtual:message";
import aliased from "@alias/alias-target.ts";
import yaml from "./data.yaml";
import json from "./data.json";

export default {
  fetch: () => Response.json({ message, aliased, yaml, json }),
};
