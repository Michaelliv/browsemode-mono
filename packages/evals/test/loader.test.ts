// Loader sanity: every YAML in tasks/ parses cleanly and has the
// minimum required shape. CI catches malformed task files before
// anyone runs the suite.

import { describe, expect, it } from "bun:test";
import { loadTasks } from "../src/loader.js";

describe("task loader", () => {
  it("loads every shipped task without throwing", () => {
    const tasks = loadTasks();
    expect(tasks.length).toBeGreaterThan(0);
  });

  it("every task has name, instruction, and judge.must", () => {
    for (const t of loadTasks()) {
      expect(t.name).toBeTruthy();
      expect(typeof t.task).toBe("string");
      expect(t.task.length).toBeGreaterThan(0);
      expect(Array.isArray(t.judge.must)).toBe(true);
      expect(t.judge.must.length).toBeGreaterThan(0);
    }
  });

  it("filter matches name or tag substring", () => {
    const all = loadTasks();
    const filtered = loadTasks("hn");
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.length).toBeLessThan(all.length);
    expect(
      filtered.every(
        (t) =>
          t.name.includes("hn") || (t.tags ?? []).some((g) => g.includes("hn")),
      ),
    ).toBe(true);
  });

  it("chrome-only tasks declare only: [chrome]", () => {
    const tasks = loadTasks("chrome-only");
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(t.only).toEqual(["chrome"]);
    }
  });
});
