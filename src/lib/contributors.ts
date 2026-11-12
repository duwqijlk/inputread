/**
 * Readers credited for meanings accepted into word lists: `contributors.json` on the books host
 * (see functions/lib/contributors.ts). Loaded at most once per page and kept in memory, so a credit
 * on the word card and the Overview rank cost one cached file, not a request per word.
 */
import { useEffect, useState } from "react";
import { booksUrl } from "@/lib/books-base";
import {
  avatarPath,
  parseBookMaintainers,
  parseContributors,
  type BookMaintainers,
  type Contributor,
} from "@/lib/contributors-file";

export type { BookMaintainers, Contributor };

type File = {
  people: Contributor[];
  byId: ReadonlyMap<string, Contributor>;
  books: Record<string, BookMaintainers>;
};

let loading: Promise<File> | null = null;
let resolved: File | null = null;

/** contributors.json, once per page: the readers, and each catalog book's maintainers. */
function loadFile(): Promise<File> {
  if (resolved) return Promise.resolve(resolved);
  // The file is kept 5 minutes by the browser and the CDN (functions/lib/contributors.ts).
  loading ??= fetch(booksUrl("contributors.json"))
    .then((response) => (response.ok ? response.json() : null))
    .then((data: unknown) => {
      const people = parseContributors(data);
      const file: File = {
        people,
        byId: new Map(people.map((person) => [person.id, person])),
        books: parseBookMaintainers(data),
      };
      resolved = file;
      return file;
    })
    .catch(() => {
      loading = null; // try again on the next card or visit
      return { people: [], byId: new Map(), books: {} };
    });
  return loading;
}

export function loadContributors(): Promise<Contributor[]> {
  return loadFile().then((file) => file.people);
}

/**
 * Start loading the file early (when a book opens), so the first credit on a word card does not
 * wait for it, and fetch the credited readers' pictures so the card shows them at once.
 */
export function preloadContributors(): void {
  void loadContributors().then((people) => {
    for (const person of people) {
      const url = avatarUrl(person.id, person.avatar);
      if (!url) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  });
}

const EMPTY_PEOPLE: Contributor[] = [];
const EMPTY_BY_ID: ReadonlyMap<string, Contributor> = new Map();
const EMPTY_BOOKS: Record<string, BookMaintainers> = {};

/** All credited readers, most help first. Empty until the file has loaded (or when there is none). */
export function useContributors(): Contributor[] {
  const [people, setPeople] = useState<Contributor[]>(() => resolved?.people ?? EMPTY_PEOPLE);
  useEffect(() => {
    if (resolved) {
      if (people !== resolved.people) setPeople(resolved.people);
      return;
    }
    let alive = true;
    void loadContributors().then((rows) => {
      if (alive) setPeople(rows);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return resolved?.people ?? people;
}

/** O(1) contributor lookup by public id for card badges. */
export function useContributorMap(): ReadonlyMap<string, Contributor> {
  const [byId, setById] = useState<ReadonlyMap<string, Contributor>>(() => resolved?.byId ?? EMPTY_BY_ID);
  useEffect(() => {
    if (resolved) {
      if (byId !== resolved.byId) setById(resolved.byId);
      return;
    }
    let alive = true;
    void loadFile().then((file) => {
      if (alive) setById(file.byId);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return resolved?.byId ?? byId;
}

/** The credited reader for one public id, once the file has loaded. */
export function useContributor(id: string | undefined): Contributor | null {
  const byId = useContributorMap();
  if (!id) return null;
  return byId.get(id) ?? null;
}

/** Every catalog book's maintainers, keyed by `<catalog>:<id>`. Empty until the file has loaded. */
export function useBookMaintainers(): Record<string, BookMaintainers> {
  const [books, setBooks] = useState<Record<string, BookMaintainers>>(() => resolved?.books ?? EMPTY_BOOKS);
  useEffect(() => {
    if (resolved) {
      if (books !== resolved.books) setBooks(resolved.books);
      return;
    }
    let alive = true;
    void loadFile().then((file) => {
      if (alive) setBooks(file.books);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return resolved?.books ?? books;
}

/**
 * The avatar image of a reader, or "" when they have none. Each picture has its own file
 * (avatars/<id>-<version>.webp), so a cached address always shows the picture it named.
 */
export function avatarUrl(id: string, version: number | undefined): string {
  const path = avatarPath(id, version);
  return path ? booksUrl(path) : "";
}
