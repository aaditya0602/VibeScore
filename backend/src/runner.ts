/** Untrusted JavaScript runs in a resource-limited QuickJS WASM runtime inside a worker.
 * No Node globals, networking, filesystem, imports, or host callbacks are exposed.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { getQuickJS } from 'quickjs-emscripten';

export interface RunCase { id: string; input?: unknown; args?: unknown[]; expected: unknown; hidden?: boolean; label?: string }
export interface RunResult { id: string; passed: boolean; error?: string; actual?: unknown; durationMs: number }
let active = 0;
export async function runCode(code: string, tests: RunCase[]): Promise<RunResult[]> {
  if (typeof code !== 'string' || code.length > 40000) throw new Error('Code must be under 40,000 characters.');
  if (!tests.length || tests.length > 30) throw new Error('Invalid test set.');
  if (active >= 2) throw new Error('The code runner is busy. Try again in a moment.');
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { code, tests }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Execution exceeded the time limit.')); }, 12000);
      worker.once('message', value => { clearTimeout(timer); void worker.terminate(); value.error ? reject(new Error(value.error)) : resolve(value.results); });
      worker.once('error', () => { clearTimeout(timer); reject(new Error('Execution stopped: resource limit or invalid program.')); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Execution stopped.')); });
    });
  } finally { active--; }
}

if (!isMainThread && parentPort) {
  const QuickJS = await getQuickJS();
  const results: RunResult[] = [];
  for (const test of workerData.tests as RunCase[]) {
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const start = Date.now();
    runtime.setInterruptHandler(() => Date.now() - start > 200);
    const vm = runtime.newContext();
    let result: RunResult = { id: test.id, passed: false, durationMs: 0 };
    try {
      const loaded = vm.evalCode(workerData.code);
      if (loaded.error) {
        loaded.error.dispose();
        result.error = 'Code could not run. Check syntax, supported JavaScript, and execution limits.';
      } else {
        loaded.value.dispose();
        const args = test.args ?? [test.input];
        const serializedArgs = args.map(x => JSON.stringify(x) ?? 'undefined').join(',');
        const evaluated = vm.evalCode(`(() => { const __args = [${serializedArgs}]; const __before = JSON.stringify(__args); const __value = solve(...__args); return { value: __value, mutated: JSON.stringify(__args) !== __before }; })()`);
        if (evaluated.error) { evaluated.error.dispose(); result.error = 'The solve function threw an error or exceeded a resource limit.'; }
        else {
          const envelope = vm.dump(evaluated.value) as { value: unknown; mutated: boolean };
          evaluated.value.dispose();
          const value = envelope?.value;
          const serialized = JSON.stringify(value);
          if (envelope?.mutated) result.error = 'The solution mutated its input. Return a new value without changing the provided data.';
          else if (serialized === undefined || serialized.length > 64000) result.error = 'Return a JSON-compatible value under 64 KB.';
          else { result.passed = isDeepStrictEqual(value, test.expected); if (!test.hidden) result.actual = value; }
        }
      }
    } catch { result.error = 'Execution failed within the isolated runner.'; }
    finally { vm.dispose(); runtime.dispose(); }
    result.durationMs = Date.now() - start;
    results.push(result);
  }
  parentPort.postMessage({ results });
}
