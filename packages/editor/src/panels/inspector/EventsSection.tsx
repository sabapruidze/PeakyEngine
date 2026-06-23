/**
 * Event Sheets were removed — Logic Sheets are now the only authoring
 * surface. This file is a tombstone: it preserves the names that legacy
 * sibling files still import (SubjectBadge, EventsSection) so the editor
 * compiles during the cutover. Everything here is invisible and
 * inactive. Once the last importer is gone these stubs will be deleted
 * with the file itself.
 */

/** Placeholder shown if anything still mounts the old component. The Main
 *  Logic Sheets UI is the actual replacement (see MainSheetView). */
export function EventsSection(): null {
  return null;
}

/** Tiny inline badge used by the old picker UI. ActionRow still imports
 *  it from this module; kept as a no-render stub so the import resolves
 *  without dragging the dead picker code along. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function SubjectBadge(_props: { subject?: unknown }): null {
  return null;
}
