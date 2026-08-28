const fs = require('fs');
const p = 'apps/web/src/views/ContractFlow.tsx';
let s = fs.readFileSync(p, 'utf8');
const icon = '\uD83D\uDCCE';
const dot = '\u00B7';
const lines = [
  '            {documents.length > 0 && (',
  '              <section className="card def-sec">',
  '                <div className="def-sec-head">',
  '                  <span className="def-sec-icon" aria-hidden>' + icon + '</span>',
  '                  <div>',
  '                    <h3>Documents</h3>',
  '                    <p>{documents.length} attached</p>',
  '                  </div>',
  '                </div>',
  '                <dl className="def-list">',
  '                  {documents.map((d) => (',
  "                    <DefRow key={String(d.id)} k={String(d.documentType ?? 'document')} v={<span><span className=\"td-cell-mono\">{String(d.documentNo ?? '')}</span>{d.mimeType ? ' " + dot + " ' + String(d.mimeType) : ''} <Badge value={d.status} /></span>} />",
  '                  ))}',
  '                </dl>',
  '              </section>',
  '            )}',
  ''
].join('\n');
const idx = s.indexOf(lines);
if (idx === -1) { console.error('BLOCK NOT FOUND'); process.exit(1); }
s = s.slice(0, idx) + s.slice(idx + lines.length);
fs.writeFileSync(p, s, 'utf8');
console.log('removed duplicate documents block from variations tab');