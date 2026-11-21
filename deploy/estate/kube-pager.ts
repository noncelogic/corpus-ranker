// The one pager for Kubernetes list reads in deploy/ (workmanship policy
// bounded-external-reads): it reads a list page by page through `continue`
// tokens and stops at a page cap. It refuses, loudly, a continue token that
// does not advance, an item seen on an earlier page (by metadata.uid, else
// namespace/name), and an empty page that still claims more; hitting the cap
// is an error the caller reports, never a silent truncation.
//
// Public: listAll(what, fetchPage, opts) -> every item, and PagerError.

export class PagerError extends Error {}

export interface Page {
  items: unknown[];
  /** The list's metadata.continue: another page exists when non-empty. */
  continue?: string;
}

export const DEFAULT_MAX_PAGES = 20;

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function itemId(item: unknown): string | undefined {
  const m = isRecord(item) && isRecord(item.metadata) ? item.metadata : undefined;
  if (!m) return undefined;
  if (typeof m.uid === "string" && m.uid !== "") return m.uid;
  if (typeof m.name === "string") return `${m.namespace ?? ""}/${m.name}`;
  return undefined;
}

/** Read every item of a list named `what`, page by page, under the guards above. */
export async function listAll(
  what: string,
  fetchPage: (cont: string | undefined) => Promise<Page>,
  opts: { maxPages?: number } = {},
): Promise<unknown[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const items: unknown[] = [];
  const seen = new Set<string>();
  const tokens = new Set<string>();
  let cont: string | undefined;
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new PagerError(`${what}: more than ${maxPages} pages; refusing to read on`);
    const p = await fetchPage(cont);
    const more = typeof p.continue === "string" && p.continue !== "";
    if (p.items.length === 0 && more) throw new PagerError(`${what}: empty page ${page} with a continue token`);
    for (const item of p.items) {
      const id = itemId(item);
      if (id !== undefined) {
        if (seen.has(id)) throw new PagerError(`${what}: item ${id} repeated on page ${page}`);
        seen.add(id);
      }
      items.push(item);
    }
    if (!more) return items;
    if (p.continue === cont || tokens.has(p.continue!)) throw new PagerError(`${what}: continue token ${JSON.stringify(p.continue)} did not advance on page ${page}`);
    tokens.add(p.continue!);
    cont = p.continue;
  }
}
