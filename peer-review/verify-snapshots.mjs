import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, unlink, rmdir, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkSnapshots, exitCode} from './check-snapshots.mjs';

const normal = JSON.parse(await readFile(new URL('./fixtures/consistent.json', import.meta.url), 'utf8'));
const changed = JSON.parse(await readFile(new URL('./fixtures/changed-snapshot.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(normal);
const field = (result, name, index = 2) => result.controls[index].fields[name];
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }

test('normal matrix includes expected false controls, not all-true acceptance', () => {
  const result = checkSnapshots(normal);
  assert.equal(result.status, 'consistent');
  assert.deepEqual(result.controls.map(row => Object.values(row.fields).map(item => item.recomputed)),
    [[false, true, false, true], [false, false, true, true], [true, true, true, true]]);
  assert.equal(result.execution_authenticity, 'unknown');
});
test('one changed head contradicts selected_commit without changing other fields', () => {
  const result = checkSnapshots(changed);
  assert.equal(result.status, 'contradiction');
  assert.equal(field(result, 'selected_commit').recomputed, false);
  assert.equal(field(result, 'selected_commit').matches_declaration, false);
  for (const key of ['shared_index_blob_preserved', 'foreign_staged_file_excluded', 'worktree_preserved'])
    assert.equal(field(result, key).judgment, 'consistent');
  assert.deepEqual(result.reported_only, checkSnapshots(normal).reported_only);
});
test('peer missing-foreign_head case stays unknown despite true and passing declarations', () => {
  const input = clone(); delete input.report.controls[2].after.foreign_head;
  const result = checkSnapshots(input);
  assert.equal(result.status, 'insufficient_evidence');
  for (const key of ['selected_commit', 'foreign_staged_file_excluded']) {
    assert.equal(field(result, key).recomputed, null);
    assert.equal(field(result, key).judgment, 'insufficient_evidence');
    assert.equal(field(result, key).declared, true);
  }
  assert.equal(result.reported_only.aggregate_status, 'passed');
  assert.equal(field(result, 'shared_index_blob_preserved').recomputed, true);
  assert.equal(result.execution_authenticity, 'unknown');
});
test('present FOREIGN_STAGED is false and contradicts the retained true flags', () => {
  const input = clone(); input.report.controls[2].after.foreign_head = 'SYNTHETIC_FOREIGN_STAGED';
  const result = checkSnapshots(input);
  for (const key of ['selected_commit', 'foreign_staged_file_excluded']) {
    assert.equal(field(result, key).recomputed, false);
    assert.equal(field(result, key).judgment, 'contradiction');
  }
});
test('a false conjunct cannot turn another missing conjunct into false', () => {
  const input = structuredClone(changed); delete input.report.controls[2].after.foreign_head;
  assert.equal(field(checkSnapshots(input), 'selected_commit').recomputed, null);
});
test('per-control before evidence is required; report.before is no substitute', () => {
  const input = clone(); delete input.fixture.before_by_command['native private index'].index;
  input.report.before = {index: 'SYNTHETIC_STAGED_B'};
  assert.equal(field(checkSnapshots(input), 'shared_index_blob_preserved').recomputed, null);
  assert.equal(field(checkSnapshots(input), 'selected_commit').recomputed, true);
});
test('per-control before snapshots are never borrowed across controls', () => {
  const input = clone(); delete input.fixture.before_by_command['native private index'];
  const result = checkSnapshots(input);
  assert.equal(field(result, 'shared_index_blob_preserved').recomputed, null);
  assert.equal(field(result, 'worktree_preserved').recomputed, null);
  assert.equal(field(result, 'shared_index_blob_preserved', 0).recomputed, true);
});
test('wrong snapshot types are unknown without coercion', () => {
  for (const value of [null, 0, false, [], {}, undefined]) {
    const input = clone(); input.report.controls[2].after.foreign_head = value;
    assert.equal(field(checkSnapshots(input), 'selected_commit').recomputed, null);
  }
});
test('each required worktree component and fixture target is necessary', () => {
  for (const key of ['worktree', 'foreign_worktree', 'untracked']) {
    const input = clone(); delete input.report.controls[2].after[key];
    assert.equal(field(checkSnapshots(input), 'worktree_preserved').recomputed, null);
  }
  const input = clone(); delete input.fixture.targets.selected_head;
  assert.equal(field(checkSnapshots(input), 'selected_commit').recomputed, null);
  assert.equal(field(checkSnapshots(input), 'foreign_staged_file_excluded').recomputed, true);
});
test('missing declarations do not prevent recomputation but prevent agreement', () => {
  const input = clone(); input.report.controls[2].selected_commit = 'true';
  const result = checkSnapshots(input);
  assert.equal(field(result, 'selected_commit').recomputed, true);
  assert.equal(field(result, 'selected_commit').matches_declaration, null);
  assert.equal(result.status, 'insufficient_evidence');
});
test('changing a declaration cannot hide a contradiction with the fixed profile', () => {
  const input = structuredClone(changed); input.report.controls[2].selected_commit = false;
  const value = field(checkSnapshots(input), 'selected_commit');
  assert.equal(value.matches_declaration, true);
  assert.equal(value.matches_profile, false);
  assert.equal(value.judgment, 'contradiction');
});
test('known contradiction and unknown evidence remain separate', () => {
  const input = structuredClone(changed); delete input.report.controls[2].after.index;
  const result = checkSnapshots(input);
  assert.equal(result.status, 'contradiction');
  assert.equal(field(result, 'shared_index_blob_preserved').recomputed, null);
});
test('untrusted aggregate and expected matrix never supply acceptance', () => {
  const input = structuredClone(changed);
  input.report.control_assessment = {status: 'passed', expected: {selected_commit: false}};
  assert.equal(checkSnapshots(input).status, 'contradiction');
});
test('primary and follow-on declarations are retained without execution claims', () => {
  const input = clone(); input.report.checks.parent_is_captured_parent = false;
  delete input.report.follow_on_control.checks.working_bytes_unchanged;
  const result = checkSnapshots(input);
  assert.equal(result.status, 'consistent'); // Controls only; those checks require other evidence.
  assert.equal(result.reported_only.primary.parent_is_captured_parent.declared, false);
  assert.equal(result.reported_only.follow_on.working_bytes_unchanged.declared, null);
  assert.equal(Object.keys(result.reported_only.primary).length, 11);
  assert.equal(Object.keys(result.reported_only.follow_on).length, 5);
});
test('invalid profile, duplicate, reordered, missing and extra controls fail closed', () => {
  for (const edit of [input => { input.data_kind = 'real'; },
    input => { input.report.controls.reverse(); }, input => { input.report.controls.pop(); },
    input => { input.report.controls.push(input.report.controls[0]); },
    input => { input.report.controls[2] = input.report.controls[0]; }]) {
    const input = clone(); edit(input);
    const result = checkSnapshots(input);
    assert.equal(result.status, 'invalid_input'); assert.equal(exitCode(result), 2);
    assert.equal(field(result, 'selected_commit').recomputed, null);
  }
});
test('report text and snapshots are not echoed, and input is unchanged', () => {
  const input = clone(); input.report.receipt = {secret: 'DO_NOT_ECHO'};
  input.report.controls[2].after.untracked = 'DO_NOT_ECHO';
  const saved = JSON.stringify(input), result = checkSnapshots(input);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO'));
  assert.equal(JSON.stringify(input), saved);
  assert.ok(!JSON.stringify(result).includes('verified_execution'));
});

const dir = await mkdtemp(join(await realpath(tmpdir()), 'commons-snapshot-review-'));
const checker = fileURLToPath(new URL('./check-snapshots.mjs', import.meta.url));
const file = join(dir, 'case.json');
try {
  for (const [name, input, status, code] of [
    ['normal', normal, 'consistent', 0], ['changed', changed, 'contradiction', 1],
    ['missing', (() => {const value = clone(); delete value.report.controls[2].after.foreign_head; return value;})(), 'insufficient_evidence', 2],
  ]) {
    await writeFile(file, JSON.stringify(input)); const before = await readFile(file);
    const run = spawnSync(process.execPath, [checker, file], {encoding:'utf8', windowsHide:true, timeout:15000});
    test('actual read-only CLI ' + name + ' and exit status', () => {
      assert.equal(run.status, code, run.stderr);
      assert.equal(JSON.parse(run.stdout).status, status);
      assert.equal(run.stderr, '');
    });
    assert.deepEqual(await readFile(file), before);
  }
  // Exercise the documented byte limit through the real CLI, including exact EOF.
  const encoded = Buffer.from(JSON.stringify(normal));
  for (const [size, status, code] of [
    [1024 * 1024, 'consistent', 0], [1024 * 1024 + 1, 'invalid_input', 2],
  ]) {
    const bytes = Buffer.concat([encoded, Buffer.alloc(size - encoded.length, 0x20)]);
    await writeFile(file, bytes);
    const run = spawnSync(process.execPath, [checker, file], {encoding:'utf8', windowsHide:true, timeout:15000});
    test('CLI regular file byte boundary ' + size, () => {
      assert.equal(run.status, code, run.stderr);
      assert.equal(JSON.parse(run.stdout).status, status);
      assert.equal(run.stderr, '');
      assert.ok(!run.stdout.includes(file));
    });
    assert.deepEqual(await readFile(file), bytes);
  }
  for (const [name, inputPath] of [['directory', dir], ['missing file', join(dir, 'absent.json')]]) {
    const run = spawnSync(process.execPath, [checker, inputPath], {encoding:'utf8', windowsHide:true, timeout:15000});
    test('CLI rejects ' + name + ' without exposing its path', () => {
      assert.equal(run.status, 2, run.stderr);
      assert.equal(run.stderr, '');
      assert.deepEqual(JSON.parse(run.stdout), {
        status:'invalid_input', code:'unreadable_oversize_or_invalid_json', execution_authenticity:'unknown',
      });
      assert.ok(!run.stdout.includes(inputPath));
    });
  }
  await writeFile(file, '{SECRET_INVALID_JSON');
  const invalid = spawnSync(process.execPath, [checker, file], {encoding:'utf8', windowsHide:true, timeout:15000});
  test('CLI invalid JSON has fixed safe error', () => {
    assert.equal(invalid.status, 2); assert.equal(invalid.stderr, '');
    assert.ok(!invalid.stdout.includes('SECRET')); assert.ok(!invalid.stdout.includes(file));
  });
} finally { await unlink(file); await rmdir(dir); }
console.log(JSON.stringify({passed:true,checks,scope:'offline synthetic consistency; actual CLI controls; no participant code or live calls',execution_authenticity:'unknown'}));
