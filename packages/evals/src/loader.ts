// Load task YAML files from disk.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EvalTask } from "./types.js";

const TASKS_DIR = resolve(import.meta.dir, "..", "tasks");

function readTaskFile(file: string): EvalTask {
  const raw = readFileSync(file, "utf8");
  const data = parseYaml(raw) ?? {};
  // Default name from filename (foo.yaml → foo).
  if (!data.name) data.name = basename(file, extname(file));
  if (!data.task || typeof data.task !== "string") {
    throw new Error(`task ${file}: missing 'task' string`);
  }
  if (!data.judge || !Array.isArray(data.judge.must)) {
    throw new Error(`task ${file}: missing judge.must (array of strings)`);
  }
  return data as EvalTask;
}

/**
 * Load every YAML file under packages/evals/tasks/. Recurses into
 * subdirectories so we can group later (`tasks/static/...`,
 * `tasks/spa/...`, etc).
 */
export function loadTasks(filter?: string): EvalTask[] {
  const tasks: EvalTask[] = [];
  walk(TASKS_DIR);
  return filter
    ? tasks.filter(
        (t) =>
          t.name.includes(filter) ||
          (t.tags ?? []).some((tag) => tag.includes(filter)),
      )
    : tasks;

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (
        st.isFile() &&
        (full.endsWith(".yaml") || full.endsWith(".yml"))
      ) {
        tasks.push(readTaskFile(full));
      }
    }
  }
}
