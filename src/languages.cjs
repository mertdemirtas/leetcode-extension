'use strict';

const LANGUAGES = [
  ['cpp', 'C++', 'cpp'], ['java', 'Java', 'java'], ['python3', 'Python3', 'py'], ['python', 'Python (legacy)', 'py'],
  ['javascript', 'JavaScript', 'js'], ['typescript', 'TypeScript', 'ts'], ['csharp', 'C#', 'cs'], ['c', 'C', 'c'],
  ['golang', 'Go', 'go'], ['kotlin', 'Kotlin', 'kt'], ['swift', 'Swift', 'swift'], ['rust', 'Rust', 'rs'],
  ['ruby', 'Ruby', 'rb'], ['php', 'PHP', 'php'], ['dart', 'Dart', 'dart'], ['scala', 'Scala', 'scala'],
  ['elixir', 'Elixir', 'ex'], ['erlang', 'Erlang', 'erl'], ['racket', 'Racket', 'rkt'], ['bash', 'Bash', 'sh'],
  ['mysql', 'MySQL', 'sql'], ['mssql', 'MS SQL Server', 'sql'], ['postgresql', 'PostgreSQL', 'sql'],
  ['oraclesql', 'Oracle SQL', 'sql'], ['pythondata', 'Pandas', 'py'], ['react', 'React', 'jsx'], ['vanillajs', 'Vanilla JS', 'js']
];

const EXTENSIONS = Object.fromEntries(LANGUAGES.map(([slug, _label, extension]) => [slug, extension]));
module.exports = { LANGUAGES, EXTENSIONS };
