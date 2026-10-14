export const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * The qualities a report or SARIF input may declare (report-format.md §5). `licensing` is not one:
 * only the server makes licence issues (6M), and an older server receiving a newer scanner's report
 * must never see it.
 */
export const REPORT_QUALITIES = ['security', 'reliability', 'maintainability'] as const;
export type ReportQuality = (typeof REPORT_QUALITIES)[number];

/** Every quality of the server's issues and rules, its API filters and the UI. */
export const QUALITIES = [...REPORT_QUALITIES, 'licensing'] as const;
export type Quality = (typeof QUALITIES)[number];

export const ISSUE_KINDS = ['issue', 'hotspot'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const LANGUAGES = [
  'typescript',
  'javascript',
  'java',
  'csharp',
  'python',
  'html',
  'css',
  'kotlin',
  'swift',
  'php',
  'ruby',
  'go',
  'c',
  'cpp',
  'other',
] as const;
export type Language = (typeof LANGUAGES)[number];

export const BUILTIN_ENGINES = [
  'eslint',
  'sonarjs',
  'ruff',
  'pmd',
  'spotbugs',
  'semgrep',
  'gitleaks',
  'trivy',
  'roslyn',
  'stylelint',
  'htmlhint',
  'detekt',
  'swiftlint',
  'phpstan',
  'rubocop',
  'staticcheck',
  'govet',
  'gosec',
  'cppcheck',
  'clang-tidy',
  'qualor',
  // 6M §6: the server's licence policy findings. Reserved: no report engine may take the id.
  'license',
  // 6M §1: the CLI's licence pass. Reserved: an external engine of that id with a status other
  // than ok would stop the server's licence stage on every analysis.
  'trivy-licenses',
] as const;
export type BuiltinEngine = (typeof BUILTIN_ENGINES)[number];

export const ENGINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
