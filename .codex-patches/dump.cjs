const fs = require('fs');
const lines = fs.readFileSync('apps/web/src/views/ContractFlow.tsx', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (l.includes("key: 'sig'") || l.includes("key: 'approval'")) {
    console.log((i + 1) + ': ' + l.split('').map((c) => c.codePointAt(0).toString(16)).join(' '));
  }
});
