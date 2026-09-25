import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  const p = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...opts });
  if (p.status !== 0) fail(`${cmd} ${args.join(' ')}\n${p.stdout}\n${p.stderr}`);
  if (!p.stdout && !p.stderr && args.includes('test')) fail(`${cmd} produced no output`);
  return p;
};

const rec = JSON.parse(await readFile(join(root, 'contracts/corpus/recommendation.json'), 'utf8'));
for (const c of rec.cases) {
  if (c.needed) {
    const raw = c.sumPp / 100 * c.capacityHours / c.periodHours;
    const nearest = Math.round(raw);
    const stable = nearest > 0 && Math.abs(raw - nearest) <= Number.EPSILON * Math.max(1, raw) * 8 ? nearest : raw;
    const got = Math.ceil(stable);
    if (got !== c.needed) fail(`${c.id}: ${got} != ${c.needed}`);
  }
}

const go = run('go', ['test', './internal/contract', './internal/calc', './internal/clock', './internal/httpserver', './webembed']);
if (!/PASS|ok/.test(`${go.stdout}${go.stderr}`)) fail(`go test reported no passing package:\n${go.stdout}`);
run('go', ['vet', './internal/contract', './internal/calc', './internal/clock', './internal/store', './internal/transport', './internal/httpserver', './webembed']);

const tsc = join(root, 'node_modules/typescript/bin/tsc');
run(process.execPath, [tsc, '-p', 'web/tsconfig.json', '--pretty', 'false']);
run(process.execPath, [tsc, '-p', 'web/tsconfig.ui.json', '--pretty', 'false', '--noEmit']);

console.log('check:port ok');
