/**
 * Prepare SQL for Node 22's experimental node:sqlite using SQLite/D1 positional rules.
 *
 * Node 22.16 treats numbered placeholders (?1, ?2, ...) as named bindings and rejects
 * positional argument lists with ERR_SQLITE_ERROR ("column index out of range").
 * Rewriting placeholders to anonymous ? slots while mapping arguments by SQLite's
 * 1-based cursor rule keeps repeated (?1 ... ?1) and out-of-order (?6 before ?4)
 * bindings identical across Node 22 and newer runtimes.
 */
export function preparePositional(db, sql) {
  const slots = [];
  let cursor = 0;
  let numbered = false;
  const rewritten = sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d*)/g,
    (match, digits) => {
      if (digits === undefined) return match;
      if (digits.length > 0) {
        numbered = true;
        cursor = Number(digits);
      } else {
        cursor += 1;
      }
      slots.push(cursor - 1);
      return "?";
    },
  );
  if (!numbered) return db.prepare(sql);
  const stmt = db.prepare(rewritten);
  const mapArgs = (args) => slots.map((index) => args[index]);
  return {
    get: (...args) => stmt.get(...mapArgs(args)),
    all: (...args) => stmt.all(...mapArgs(args)),
    run: (...args) => stmt.run(...mapArgs(args)),
  };
}
