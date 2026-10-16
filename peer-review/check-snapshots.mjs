// Finite, offline consistency review. No Git, participant code, models or HTTP.
import {open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const commands = Object.freeze([
  'git commit', 'git commit --only shared.py', 'native private index',
]);
export const fields = Object.freeze([
  'selected_commit', 'shared_index_blob_preserved',
  'foreign_staged_file_excluded', 'worktree_preserved',
]);
const expected = [
  [false, true, false, true],
  [false, false, true, true],
  [true, true, true, true],
];
const primaryNames = [
  'commit_contains_only_A', 'staged_B_blob_unchanged', 'working_A_B_C_unchanged',
  'foreign_staged_and_working_bytes_unchanged', 'parent_is_captured_parent',
  'receipt_identifies_commit', 'plan_preserves_repository',
  'cached_diff_matches_stored_blobs', 'working_changes_remain_detectable',
  'preserved_staging_risk_is_reported', 'stale_parent_refused_without_writes',
];
const followOnNames = [
  'selected_commit_contains_A', 'retained_index_differs_from_selected_commit',
  'ordinary_commit_reverses_A', 'ordinary_commit_follows_selected_commit',
  'working_bytes_unchanged',
];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const string = (value, key) => own(value, key) && typeof value[key] === 'string';
const boolean = (value, key) => own(value, key) && typeof value[key] === 'boolean';
const reportedChecks = (source, names) => Object.fromEntries(names.map(name => [name, {
  declared: boolean(source, name) ? source[name] : null,
  evidence: boolean(source, name) ? 'reported_only' : 'missing_or_invalid',
}]));

export function checkSnapshots(input) {
  const report = object(input?.report) ? input.report : {};
  const fixture = object(input?.fixture) ? input.fixture : {};
  const validProfile = input?.schema === 'commons_snapshot_fixture_v1'
    && input?.data_kind === 'fully_synthetic' && report.schema === 'one_checkout_demo_v1';
  const rows = Array.isArray(report.controls) ? report.controls : [];
  const validControls = rows.length === commands.length
    && commands.every((command, index) => rows[index]?.command === command);
  const invalid = !validProfile || !validControls;
  const controls = commands.map((command, index) => {
    const row = validControls ? rows[index] : {};
    const after = row?.after;
    const before = own(fixture.before_by_command, command) ? fixture.before_by_command[command] : {};
    const target = fixture.targets;
    // Never short-circuit absent evidence into false, even if another conjunct is false.
    const requirements = [
      [[after, 'head', 'after.head'], [after, 'foreign_head', 'after.foreign_head'],
        [target, 'selected_head', 'fixture.targets.selected_head'], [target, 'foreign_base', 'fixture.targets.foreign_base']],
      [[after, 'index', 'after.index'], [before, 'index', 'fixture.before.index']],
      [[after, 'foreign_head', 'after.foreign_head'], [target, 'foreign_base', 'fixture.targets.foreign_base']],
      ['worktree', 'foreign_worktree', 'untracked'].flatMap(key => [
        [after, key, 'after.' + key], [before, key, 'fixture.before.' + key],
      ]),
    ];
    const predicates = [
      () => after.head === target.selected_head && after.foreign_head === target.foreign_base,
      () => after.index === before.index,
      () => after.foreign_head === target.foreign_base,
      () => ['worktree', 'foreign_worktree', 'untracked'].every(key => after[key] === before[key]),
    ];
    return {command, fields: Object.fromEntries(fields.map((field, fieldIndex) => {
      const absent = requirements[fieldIndex].filter(([container, key]) => !string(container, key)).map(item => item[2]);
      const value = !invalid && absent.length === 0 ? predicates[fieldIndex]() : null;
      const declared = boolean(row, field) ? row[field] : null;
      const expectedValue = expected[index][fieldIndex];
      const matchesDeclaration = value === null || declared === null ? null : value === declared;
      const matchesProfile = value === null ? null : value === expectedValue;
      const contradiction = matchesDeclaration === false || matchesProfile === false;
      return [field, {
        declared, profile_expected: expectedValue, recomputed: value,
        matches_declaration: matchesDeclaration, matches_profile: matchesProfile,
        judgment: contradiction ? 'contradiction' : value === null || declared === null ? 'insufficient_evidence' : 'consistent',
        missing_or_invalid: [
          ...(!validProfile ? ['fixture_profile'] : []),
          ...(!validControls ? ['ordered_control_set'] : []), ...absent,
          ...(!boolean(row, field) ? ['declared_boolean'] : []),
        ],
      }];
    }))};
  });
  const outcomes = controls.flatMap(row => Object.values(row.fields));
  const status = invalid ? 'invalid_input'
    : outcomes.some(field => field.judgment === 'contradiction') ? 'contradiction'
      : outcomes.some(field => field.judgment === 'insufficient_evidence') ? 'insufficient_evidence' : 'consistent';
  return {
    profile: 'commons_snapshot_fixture_v1', status,
    scope: 'finite_snapshot_consistency_only', execution_authenticity: 'unknown',
    before_values: 'per_control_synthetic_fixture_declarations_not_observed_runs',
    controls,
    reported_only: {
      aggregate_status: ['passed', 'failed'].includes(report.control_assessment?.status) ? report.control_assessment.status : null,
      primary: reportedChecks(report.checks, primaryNames),
      follow_on: reportedChecks(report.follow_on_control?.checks, followOnNames),
      verification: 'not_recomputed_or_execution_verified',
    },
  };
}

export const exitCode = result => result.status === 'consistent' ? 0 : result.status === 'contradiction' ? 1 : 2;

async function main() {
  if (process.argv.length !== 3) {
    console.log(JSON.stringify({status: 'invalid_input', code: 'one_local_json_file_required', execution_authenticity: 'unknown'}));
    process.exitCode = 2; return;
  }
  let file;
  try {
    file = await open(process.argv[2], 'r');
    if (!(await file.stat()).isFile()) throw Error();
    const limit = 1024 * 1024;
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > limit) throw Error();
    const result = checkSnapshots(JSON.parse(buffer.subarray(0, size).toString('utf8')));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exitCode(result);
  } catch {
    console.log(JSON.stringify({status: 'invalid_input', code: 'unreadable_oversize_or_invalid_json', execution_authenticity: 'unknown'}));
    process.exitCode = 2;
  } finally { await file?.close(); }
}

// Canonicalize an entry-point alias as well as the module URL (portable temp roots).
import {realpath} from 'node:fs/promises';
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) await main();
