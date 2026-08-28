const fs = require('fs');
const p = 'apps/web/src/views/ContractFlow.tsx';
let s = fs.readFileSync(p, 'utf8');
const emDash = '\u2014';
const arrow = '\u2192';
const oldBlock = [
  '                      {changes.map((ch, idx) => (',
  "                        <DefRow key={idx} k={String(ch.label ?? ch.field ?? 'change')} v={<span><span className=\"muted\">{String(ch.oldValue ?? '" + emDash + "')}</span> <span className=\"muted\" aria-hidden>" + arrow + "</span> <span className=\"td-strong\">{String(ch.newValue ?? '" + emDash + "')}</span></span>} />",
  '                      ))}'
].join('\n');
const newBlock = [
  '                      {changes.map((ch, idx) => {',
  "                        const oldV = String(ch.oldValue ?? '');",
  "                        const newV = String(ch.newValue ?? '');",
  "                        const added = oldV === '' && newV !== '';",
  "                        const removed = newV === '' && oldV !== '';",
  '                        return (',
  '                          <DefRow',
  '                            key={idx}',
  "                            k={String(ch.label ?? ch.field ?? 'change')}",
  '                            v={added ? (',
  '                              <span><span className="diff-badge diff-add">Added</span> <span className="td-strong">{newV}</span></span>',
  '                            ) : removed ? (',
  '                              <span><span className="diff-badge diff-del">Removed</span> <span className="muted">{oldV}</span></span>',
  '                            ) : (',
  "                              <span><span className=\"muted\">{oldV || '\\u2014'}</span> <span className=\"muted\" aria-hidden>{'\\u2192'}</span> <span className=\"diff-badge diff-mod\">Modified</span> <span className=\"td-strong\">{newV || '\\u2014'}</span></span>",
  '                            )}',
  '                          />',
  '                        );',
  '                      })}'
].join('\n');
if (!s.includes(oldBlock)) { console.error('OLD BLOCK NOT FOUND'); process.exit(1); }
s = s.replace(oldBlock, newBlock);
fs.writeFileSync(p, s, 'utf8');
console.log('diff badges applied to variations changes');