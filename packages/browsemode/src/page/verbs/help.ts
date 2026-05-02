// Per-verb schema metadata. Mirrors runline's pattern: each verb
// declares description + typed inputs, the engine builds a help
// table at sandbox boot, the sandbox exposes `api.list/find/
// describe/check` so the agent can introspect at runtime instead
// of guessing from a static primer.
//
// Schemas are intentionally separate from the runtime handlers in
// PAGE_VERBS / ELEMENT_VERBS: the dispatch path stays untouched,
// metadata is opt-in. A handler without a spec just shows up in
// `api.list()` with description "(no spec)".

export type VerbInputType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface VerbInput {
  type: VerbInputType;
  required?: boolean;
  description?: string;
  /** Optional enum values for string-typed inputs. */
  oneOf?: string[];
}

export interface VerbSpec {
  description: string;
  /**
   * Argument schema for the canonical object-form call. Most verbs
   * accept multiple shapes (e.g. `goto("url")` or `goto({url})`);
   * the schema documents the object form which always works.
   */
  inputs?: Record<string, VerbInput>;
  /** Concrete one-liner usage examples the agent can copy-paste. */
  examples?: string[];
  /**
   * Element verbs only: which scanner-detected kinds support this
   * verb. Page verbs leave this undefined.
   */
  appliesTo?: ReadonlyArray<string>;
}

export interface VerbCatalogEntry {
  /** "page.goto" or "element.click" or "tabs.open". */
  path: string;
  /** Short id ("goto", "click"). */
  name: string;
  /** Verb namespace: "page" / "element" / "tabs". */
  scope: "page" | "element" | "tabs";
  description: string;
  inputs: Record<string, VerbInput>;
  examples: string[];
  appliesTo?: ReadonlyArray<string>;
}

export interface VerbCatalog {
  entries: VerbCatalogEntry[];
}

/**
 * Build a single flat catalog of every verb the agent can call,
 * suitable for baking into the sandbox as JSON. The sandbox's
 * `api.*` helpers index this for list/find/describe/check.
 */
export function buildVerbCatalog(input: {
  page: Record<string, VerbSpec>;
  element: Record<string, VerbSpec>;
  tabs: Record<string, VerbSpec>;
}): VerbCatalog {
  const entries: VerbCatalogEntry[] = [];
  for (const [name, spec] of Object.entries(input.page)) {
    entries.push({
      path: `page.${name}`,
      name,
      scope: "page",
      description: spec.description,
      inputs: spec.inputs ?? {},
      examples: spec.examples ?? [],
    });
  }
  for (const [name, spec] of Object.entries(input.element)) {
    entries.push({
      path: `element.${name}`,
      name,
      scope: "element",
      description: spec.description,
      inputs: spec.inputs ?? {},
      examples: spec.examples ?? [],
      appliesTo: spec.appliesTo,
    });
  }
  for (const [name, spec] of Object.entries(input.tabs)) {
    entries.push({
      path: `tabs.${name}`,
      name,
      scope: "tabs",
      description: spec.description,
      inputs: spec.inputs ?? {},
      examples: spec.examples ?? [],
    });
  }
  return { entries };
}

/** Format `verb({ a: type, b?: type })` for compact display. */
export function formatSignature(entry: VerbCatalogEntry): string {
  const fields = Object.entries(entry.inputs)
    .map(([k, v]) => `${k}${v.required ? "" : "?"}: ${v.type}`)
    .join(", ");
  return `${entry.path}(${fields ? `{ ${fields} }` : ""})`;
}
