// ap-run.cjs — apply a UTF-8 patch file via the codex apply_patch runner.
// Node spawns codex.exe directly so multi-byte (emoji) arguments survive,
// unlike PowerShell 5.1 native-argument passing.
const { spawnSync } = require('child_process');
const fs = require('fs');

const EXE = 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const file = process.argv[2];
if (!file) {
  console.error('usage: node .codex-patches/ap-run.cjs <patch-file>');
  process.exit(1);
}
let patch = fs.readFileSync(file, 'utf8');
if (patch.charCodeAt(0) === 0xFEFF) patch = patch.slice(1);
const r = spawnSync(EXE, ['--codex-run-as-apply-patch', patch], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status == null ? 1 : r.status);
