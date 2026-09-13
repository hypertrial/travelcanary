export function catalogMembershipHash(ids: string[]) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const id of [...ids].sort()) for (const code of `${id}\0`) {
    first = Math.imul(first ^ code.charCodeAt(0), 0x01000193);
    second = Math.imul(second ^ code.charCodeAt(0), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
