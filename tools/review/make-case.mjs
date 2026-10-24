// Builds the patch.diff of a case of the AI review's evaluation set (fixtures/review-eval/<case>)
// from its base/ and head/ trees, with git, as the scanner's snapshot carries a patch: the diff of
// the merge base against the head with three lines of context and a/ and b/ paths, one piece for
// each changed file, without git's `index` lines and without the function context git writes after
// a hunk's ranges. A rename is a deleted file and an added one (no `-M`), so that a case's changes
// are the files that differ between the two trees and nothing else (tools/review/eval.ts reads it
// back that way).
//
//   node tools/review/make-case.mjs                     every case: writes its patch.diff
//   node tools/review/make-case.mjs <case-dir>...       these cases
//   node tools/review/make-case.mjs --check [<dir>...]  writes nothing; exits 1 for a patch.diff
//                                                       that is not what base/ and head/ give
//
// Run it after any change to a base/ or head/ file. The trees are read in place, never copied, and
// git runs in a temporary directory of its own with none of the user's or the system's
// configuration.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/review-eval',
);

/** Git's `index <old>..<new> [mode]` line, which names the blobs of both sides. */
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/;
/** A hunk header: its ranges, then the function context git appends. */
const HUNK_HEADER = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/;

/** The environment git runs in: the caller's, without a git variable that would steer it. */
function inheritedEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}

/** The diff as the snapshot holds it: no index lines (a line of a hunk never starts with `index`). */
function tidy(diff) {
  return diff
    .split('\n')
    .filter((line) => !INDEX_LINE.test(line))
    .map((line) => line.replace(HUNK_HEADER, '$1'))
    .join('\n');
}

/**
 * The patch of a case: the diff of its base/ tree against its head/ tree. A tree that is not there
 * (a case that only adds files has no base/) is empty.
 */
export function buildPatch(caseDir) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'qualor-review-case-'));
  try {
    const gitDir = path.join(work, 'repo');
    const git = (args, env = {}, cwd = work) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...inheritedEnv(),
          HOME: work,
          GIT_DIR: gitDir,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          ...env,
        },
      });
    git(['init', '--quiet', '--bare', gitDir]);
    /** The id of the tree of `dir`, whose files are added to a temporary index of their own. */
    const treeOf = (name, dir) => {
      const tree = existsSync(dir) ? dir : mkdtempSync(path.join(work, 'empty-'));
      const env = { GIT_INDEX_FILE: path.join(work, `index-${name}`), GIT_WORK_TREE: tree };
      git(['-c', 'core.autocrlf=false', 'add', '--all', '--force', '--', '.'], env, tree);
      return git(['write-tree'], env, tree).trim();
    };
    const base = treeOf('base', path.join(caseDir, 'base'));
    const head = treeOf('head', path.join(caseDir, 'head'));
    const diff = git([
      '-c',
      'core.quotepath=off',
      'diff-tree',
      '--patch',
      '--unified=3',
      '--no-renames',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--diff-algorithm=myers',
      '--inter-hunk-context=0',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
      head,
    ]);
    return tidy(diff);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function caseDirs(args) {
  if (args.length > 0) return args.map((dir) => path.resolve(dir));
  return readdirSync(CASES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(CASES, entry.name))
    .sort();
}

function main(argv) {
  const check = argv.includes('--check');
  const dirs = caseDirs(argv.filter((arg) => arg !== '--check'));
  let stale = 0;
  for (const dir of dirs) {
    const patch = buildPatch(dir);
    const file = path.join(dir, 'patch.diff');
    if (!check) {
      writeFileSync(file, patch);
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    } else if (!existsSync(file) || readFileSync(file, 'utf8') !== patch) {
      stale += 1;
      console.error(`stale: ${path.relative(process.cwd(), file)}`);
    }
  }
  if (stale > 0) {
    console.error(`${stale} patch.diff not current; run node tools/review/make-case.mjs`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
