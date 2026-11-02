import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const environment = fileURLToPath(new URL('../node_modules/.mailflare-recovery-python/', import.meta.url));
const requirements = fileURLToPath(new URL('./requirements-recovery.txt', import.meta.url));
const interpreter = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export function recoveryTestPython() {
  if (!existsSync(interpreter)) {
    throw new Error('Recovery test Python is missing. Run npm run test:python:setup first (npm test does this automatically).');
  }
  return interpreter;
}

function prepare() {
  mkdirSync(dirname(environment), { recursive: true });
  if (!existsSync(interpreter)) {
    // Do not inherit installed system packages: they hid missing test dependencies in CI.
    execFileSync('python3', ['-I', '-m', 'venv', environment], { stdio: 'inherit' });
  }
  const configuration = readFileSync(join(environment, 'pyvenv.cfg'), 'utf8');
  if (!/^include-system-site-packages\s*=\s*false\s*$/mi.test(configuration)) {
    throw new Error('Recovery test Python must be isolated. Remove node_modules/.mailflare-recovery-python and rerun npm run test:python:setup.');
  }
  execFileSync(interpreter, ['-I', '-c', [
    'import sys',
    'assert sys.version_info >= (3, 10), "Recovery tests require Python 3.10+"',
    'assert sys.prefix != sys.base_prefix, "Recovery tests require a virtual environment"',
  ].join('\n')], { stdio: 'inherit' });
  // Exact pins and hashes cover runtime dependencies too. Wheels avoid a Rust/C
  // toolchain on Cloudflare Builds; satisfied installs are reused without downloads.
  execFileSync(interpreter, [
    '-I', '-m', 'pip', '--require-virtualenv', '--disable-pip-version-check',
    'install', '--require-hashes', '--only-binary=:all:', '-r', requirements,
  ], { stdio: 'inherit' });
  execFileSync(interpreter, ['-I', '-m', 'pip', '--require-virtualenv', '--disable-pip-version-check', 'check'], { stdio: 'inherit' });
  console.log('Isolated Python dependencies for encrypted backup recovery tests are ready.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepare();
}
