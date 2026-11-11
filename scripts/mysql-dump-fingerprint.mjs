import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// MySQL8.4 SHOW CREATE adds this redundant explicit charset after dump/import.
// COLLATE utf8mb4_0900_as_cs already fixes the charset to utf8mb4.
// Rows, string literals, other collations, keys and constraints stay exact.
function column(line) {
  if (!/^  `(?:[^`]|``)+` /.test(line)) return line;
  const explicit = ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs';
  let quote = '',
    output = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index],
      next = line[index + 1];
    if (quote) {
      output += char;
      if (char === '\\' && next) {
        output += next;
        index++;
      } else if (char === quote) {
        if (next === quote) {
          output += next;
          index++;
        } else quote = '';
      }
    } else if ('\'"`'.includes(char)) {
      quote = char;
      output += char;
    } else if (char === '/' && next === '*') {
      const end = line.indexOf('*/', index + 2);
      if (end < 0) return line;
      output += line.slice(index, end + 2);
      index = end + 1;
    } else if (
      line.startsWith(explicit, index) &&
      (!line[index + explicit.length] || /[ ,]/.test(line[index + explicit.length]))
    ) {
      output += ' COLLATE utf8mb4_0900_as_cs';
      index += explicit.length - 1;
    } else output += char;
  }
  return output;
}
export async function mysqlDumpFingerprint(chunks) {
  const hash = createHash('sha256'),
    decoder = new StringDecoder('utf8');
  let pending = '',
    definition = false;
  const line = (value) => {
    if (/^CREATE TABLE `(?:[^`]|``)+` \(\n?$/.test(value)) definition = true;
    hash.update(definition ? column(value) : value);
    if (/^\) ENGINE=/.test(value)) definition = false;
  };
  for await (const bytes of chunks) {
    pending += decoder.write(bytes);
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      line(pending.slice(0, index + 1));
      pending = pending.slice(index + 1);
    }
    if (Buffer.byteLength(pending) > 64 * 1024 * 1024)
      throw new Error('SQL line exceeds recovery fingerprint policy');
  }
  pending += decoder.end();
  if (pending) line(pending);
  return hash.digest('hex');
}
