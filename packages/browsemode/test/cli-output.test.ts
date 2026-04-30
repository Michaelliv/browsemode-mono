import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { output } from "../src/cli/output.js";

// Capture stdout for the duration of one assertion. We replace
// process.stdout.write with a buffer collector and restore on cleanup.
let stdoutBuf = "";
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  stdoutBuf = "";
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    stdoutBuf += chunk;
    return true;
  };
});

afterEach(() => {
  (process.stdout.write as any) = origWrite;
});

describe("output triple", () => {
  it("--json picks the json handler and writes JSON", () => {
    output({ json: true }, {
      json: () => ({ x: 1 }),
      human: () => {
        throw new Error("should not run");
      },
    });
    expect(stdoutBuf).toContain('"x": 1');
  });

  it("--quiet picks the quiet handler", () => {
    let q = false;
    output({ quiet: true }, {
      quiet: () => {
        q = true;
      },
      human: () => {
        throw new Error("should not run");
      },
    });
    expect(q).toBe(true);
  });

  it("default falls through to human", () => {
    let h = false;
    output({}, {
      json: () => ({ x: 1 }),
      quiet: () => {
        throw new Error("should not run");
      },
      human: () => {
        h = true;
      },
    });
    expect(h).toBe(true);
  });

  it("--json without a json handler still falls back to human", () => {
    let h = false;
    output({ json: true }, {
      human: () => {
        h = true;
      },
    });
    expect(h).toBe(true);
  });

  it("--quiet without a quiet handler still falls back to human", () => {
    let h = false;
    output({ quiet: true }, {
      human: () => {
        h = true;
      },
    });
    expect(h).toBe(true);
  });
});
