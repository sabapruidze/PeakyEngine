import { readFileSync } from "fs";
const base = "g:/VSCODE PROJECTS/Peaky Engine v2";

const actionTs = readFileSync(`${base}/packages/shared/src/sm/action.ts`, "utf8");
const unionStart = actionTs.indexOf("export type StateActionKind =");
// Strip line comments before finding `;` so comment-internal `;` doesn't confuse us
function findTopLevelSemicolon(src, from) {
  let i = from;
  while (i < src.length) {
    if (src[i] === "/" && src[i+1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src[i] === ";") {
      return i;
    } else { i++; }
  }
  return -1;
}
function stripLineComments(src) {
  // Drop // line comments to avoid string literals inside comments matching.
  return src.replace(/\/\/[^\n]*/g, "");
}
const unionEnd = findTopLevelSemicolon(actionTs, unionStart);
const unionStr = stripLineComments(actionTs.slice(unionStart, unionEnd));
const allActionKinds = [...unionStr.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]);
console.log("StateActionKind:", allActionKinds.length);

const aKindsStart = actionTs.indexOf("export const ACTION_KINDS:");
const aKindsEnd = actionTs.indexOf("];", aKindsStart);
const aKindsStr = actionTs.slice(aKindsStart, aKindsEnd);
const actionKindsArr = [...aKindsStr.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]);
console.log("ACTION_KINDS array:", actionKindsArr.length);

const setUnion = new Set(allActionKinds);
const setArr = new Set(actionKindsArr);
console.log("In union but not ACTION_KINDS[]:", [...setUnion].filter(k => !setArr.has(k)));
console.log("In ACTION_KINDS[] but not union:", [...setArr].filter(k => !setUnion.has(k)));

const objTs = readFileSync(`${base}/packages/shared/src/sm/objects.ts`, "utf8");
function extractList(name) {
  // Match the `export const NAME...= [...]` for this exact name.
  const re = new RegExp(`export const ${name}\\s*:\\s*[A-Za-z<>\\[\\] ]+\\s*=\\s*\\[`);
  const m = re.exec(objTs);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  let depth = 0, end = -1;
  for (let i = open; i < objTs.length; i++) {
    if (objTs[i] === "[") depth++;
    else if (objTs[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  const slice = objTs.slice(open, end);
  return [...slice.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(m => m[1]);
}
const SYSTEM_ACTION = extractList("SYSTEM_ACTION_KINDS");
const BP_ACTION = extractList("BP_ACTION_KINDS");
const MOUSE_ACTION = extractList("MOUSE_ACTION_KINDS");
const UIWIDGET_ACTION = extractList("UIWIDGET_ACTION_KINDS");
// UIWIDGET_UNIVERSAL_ACTION_KINDS is declared without `export` — handle separately
function extractListLoose(name, src = objTs) {
  const re = new RegExp(`const ${name}\\s*:\\s*[A-Za-z<>\\[\\] ]+\\s*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  const slice = src.slice(open, end);
  return [...slice.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(m => m[1]);
}
const UIWIDGET_UNIVERSAL = extractListLoose("UIWIDGET_UNIVERSAL_ACTION_KINDS");
const allCovered = new Set([...SYSTEM_ACTION, ...BP_ACTION, ...MOUSE_ACTION, ...UIWIDGET_ACTION, ...UIWIDGET_UNIVERSAL]);
console.log("\n--- Action subject coverage ---");
console.log("Not in any allow-list:", [...setUnion].filter(k => !allCovered.has(k)));
console.log("Allow-list orphans:", [...allCovered].filter(k => !setUnion.has(k)));

const eventsTs = readFileSync(`${base}/packages/editor/src/panels/inspector/EventsSection.tsx`, "utf8");
function extractRecord(constName, source) {
  const idx = source.indexOf(`const ${constName}`);
  if (idx < 0) return [];
  const open = source.indexOf("{", idx);
  let depth = 0, end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const slice = source.slice(open, end);
  return [...slice.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(m => m[1]);
}
const ACTION_CATEGORIES = new Set(extractRecord("ACTION_CATEGORIES", eventsTs));
const SYSTEM_ACTION_GROUPS = new Set(extractRecord("SYSTEM_ACTION_GROUPS", eventsTs));
console.log("\n--- ACTION_CATEGORIES ---");
console.log("Not in ACTION_CATEGORIES:", [...setUnion].filter(k => !ACTION_CATEGORIES.has(k)));
console.log("ACTION_CATEGORIES orphans:", [...ACTION_CATEGORIES].filter(k => !setUnion.has(k)));

const nrTs = readFileSync(`${base}/packages/editor/src/panels/inspector/LogicSheet/nodeRegistry.ts`, "utf8");
function extractComponentMap(constName) {
  const idx = nrTs.indexOf(`const ${constName}`);
  if (idx < 0) return [];
  const open = nrTs.indexOf("{", idx);
  let depth = 0, end = -1;
  for (let i = open; i < nrTs.length; i++) {
    if (nrTs[i] === "{") depth++;
    else if (nrTs[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const slice = nrTs.slice(open, end);
  return [...slice.matchAll(/([A-Z][A-Za-z0-9]+)\s*:\s*"/g)].map(m => m[1]);
}
const ACTION_TO_COMPONENT = new Set(extractComponentMap("ACTION_TO_COMPONENT"));
const CONDITION_TO_COMPONENT = new Set(extractComponentMap("CONDITION_TO_COMPONENT"));
console.log("\n--- ACTION_TO_COMPONENT ---");
console.log("Not in ACTION_TO_COMPONENT:", [...setUnion].filter(k => !ACTION_TO_COMPONENT.has(k)));
console.log("ACTION_TO_COMPONENT orphans:", [...ACTION_TO_COMPONENT].filter(k => !setUnion.has(k)));

const condTs = readFileSync(`${base}/packages/shared/src/sm/condition.ts`, "utf8");
const cUnionStart = condTs.indexOf("export type ConditionKind =");
const cUnionEnd = findTopLevelSemicolon(condTs, cUnionStart);
const cUnionStr = stripLineComments(condTs.slice(cUnionStart, cUnionEnd));
const allCondKinds = [...cUnionStr.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]);
console.log("\n\nConditionKind:", allCondKinds.length);

const cKindsStart = condTs.indexOf("export const CONDITION_KINDS:");
const cKindsEnd = condTs.indexOf("];", cKindsStart);
const cKindsStr = condTs.slice(cKindsStart, cKindsEnd);
const cKindsArr = [...cKindsStr.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]);
const setCUnion = new Set(allCondKinds);
const setCArr = new Set(cKindsArr);
console.log("In ConditionKind but not CONDITION_KINDS[]:", [...setCUnion].filter(k => !setCArr.has(k)));
console.log("In CONDITION_KINDS[] but not union:", [...setCArr].filter(k => !setCUnion.has(k)));

const SYSTEM_COND = extractList("SYSTEM_CONDITION_KINDS");
const BP_COND = extractList("BP_CONDITION_KINDS");
const MOUSE_COND = extractList("MOUSE_CONDITION_KINDS");
const KEYBOARD_COND = extractList("KEYBOARD_CONDITION_KINDS");
const UIWIDGET_COND = extractListLoose("UIWIDGET_CONDITION_KINDS");
const allCondCovered = new Set([...SYSTEM_COND, ...BP_COND, ...MOUSE_COND, ...KEYBOARD_COND, ...UIWIDGET_COND]);
console.log("\n--- Condition subject coverage ---");
console.log("Not in any allow-list:", [...setCUnion].filter(k => !allCondCovered.has(k)));
console.log("Allow-list orphans:", [...allCondCovered].filter(k => !setCUnion.has(k)));

const CONDITION_CATEGORIES = new Set(extractRecord("CONDITION_CATEGORIES", eventsTs));
console.log("\n--- CONDITION_CATEGORIES ---");
console.log("Not in CONDITION_CATEGORIES:", [...setCUnion].filter(k => !CONDITION_CATEGORIES.has(k)));
console.log("CONDITION_CATEGORIES orphans:", [...CONDITION_CATEGORIES].filter(k => !setCUnion.has(k)));

console.log("\n--- CONDITION_TO_COMPONENT ---");
console.log("Not in CONDITION_TO_COMPONENT:", [...setCUnion].filter(k => !CONDITION_TO_COMPONENT.has(k)));
console.log("CONDITION_TO_COMPONENT orphans:", [...CONDITION_TO_COMPONENT].filter(k => !setCUnion.has(k)));

const projTs = readFileSync(`${base}/packages/editor/src/project.ts`, "utf8");
const bUnionStart = projTs.indexOf("export type BehaviorKind =");
const bUnionEnd = findTopLevelSemicolon(projTs, bUnionStart);
const allBehKinds = [...projTs.slice(bUnionStart, bUnionEnd).matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(m => m[1]);
console.log("\n\nBehaviorKind:", allBehKinds);

const storeTs = readFileSync(`${base}/packages/editor/src/store.ts`, "utf8");
const knownIdx = storeTs.indexOf("KNOWN_KINDS = new Set");
const knownEnd = storeTs.indexOf("]", knownIdx);
const knownSlice = storeTs.slice(knownIdx, knownEnd);
const knownKinds = new Set([...knownSlice.matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]));
const setBeh = new Set(allBehKinds);
console.log("KNOWN_KINDS missing:", [...setBeh].filter(k => !knownKinds.has(k)));
console.log("KNOWN_KINDS orphans:", [...knownKinds].filter(k => !setBeh.has(k)));

// Check CONDITION_PARAM_DEFAULTS in nodeRegistry
function extractMapKeysSimple(constName, source) {
  const idx = source.indexOf(`const ${constName}`);
  if (idx < 0) return [];
  const open = source.indexOf("{", idx);
  let depth = 0, end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const slice = source.slice(open, end);
  // keys followed by `:` at depth 1
  return [...slice.matchAll(/(?:^|,|\n)\s*([A-Z][A-Za-z0-9]+)\s*:/g)].map(m => m[1]);
}
const CONDITION_PARAM_DEFAULTS = new Set(extractMapKeysSimple("CONDITION_PARAM_DEFAULTS", nrTs));
console.log("\n--- CONDITION_PARAM_DEFAULTS (nodeRegistry) ---");
console.log("Conditions NOT in CONDITION_PARAM_DEFAULTS:", [...setCUnion].filter(k => !CONDITION_PARAM_DEFAULTS.has(k)));
console.log("CONDITION_PARAM_DEFAULTS orphans:", [...CONDITION_PARAM_DEFAULTS].filter(k => !setCUnion.has(k)));
