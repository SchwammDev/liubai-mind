// `before` is the file on disk and `after` is the disk content with the edit
// applied — not the edit's own old/new strings, which carry no surrounding
// context. Function rules need the full file; the comment rule's before/after
// line-set diff then sees added lines correctly.
export function applyEdits(text: string, edits: { oldText: string; newText: string }[]): string {
  let out = text;
  for (const edit of edits) out = out.replace(edit.oldText, edit.newText);
  return out;
}

export async function safeRead(read: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    return await read(path);
  } catch {
    return "";
  }
}

export interface WriteChange { kind: "write"; path: string; content: string }
export interface EditChange { kind: "edit"; path: string; edits: { oldText: string; newText: string }[] }
export type FileChange = WriteChange | EditChange;

export async function reconstruct(
  change: FileChange,
  read: (path: string) => Promise<string>,
): Promise<{ path: string; before: string; after: string }> {
  const before = await safeRead(read, change.path);
  const after = change.kind === "write" ? change.content : applyEdits(before, change.edits);
  return { path: change.path, before, after };
}
