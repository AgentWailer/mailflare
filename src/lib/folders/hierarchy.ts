type Label = { id: string; name: string; parentId?: string | null };

/** Cycle-safe paths also keep imported orphan labels accessible. */
export function getLabelPath(label: Label, labels: Label[]): string {
 const lookup = new Map(labels.map(item => [item.id, item]));
 const names = [label.name], seen = new Set([label.id]);
 let parent = label.parentId ? lookup.get(label.parentId) : undefined;
 while (parent && !seen.has(parent.id)) {
  names.unshift(parent.name); seen.add(parent.id);
  parent = parent.parentId ? lookup.get(parent.parentId) : undefined;
 }
 return names.join(" / ");
}

export function canNestLabel(labelId: string, parentId: string, labels: Label[]): boolean {
 const lookup = new Map(labels.map(item => [item.id, item]));
 const seen = new Set<string>();
 let current: Label | undefined = lookup.get(parentId);
 if (!current) return false;
 while (current) {
  if (current.id === labelId || seen.has(current.id)) return false;
  seen.add(current.id); current = current.parentId ? lookup.get(current.parentId) : undefined;
 }
 return true;
}

/** Hiding a parent never implicitly hides its visible descendants. */
export function visibleLabelGroups<T extends Label>(labels: T[], hiddenIds: string[]): Map<string | null, T[]> {
 const hidden = new Set(hiddenIds), visible = labels.filter(item => !hidden.has(item.id));
 const ids = new Set(visible.map(item => item.id)), groups = new Map<string | null, T[]>();
 for (const item of visible) {
  const parent = item.parentId && ids.has(item.parentId) && canNestLabel(item.id, item.parentId, labels) ? item.parentId : null;
  groups.set(parent, [...(groups.get(parent) ?? []), item]);
 }
 return groups;
}
