import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRemoteLine } from './git.js';

const TESTS = [
  // Basic GitHub SSH
  {
    input: 'origin  git@github.com:cnlangzi/gfwproxy (fetch)',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub SSH with (fetch) suffix',
  },
  {
    input: 'origin  git@github.com:cnlangzi/gfwproxy (push)',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub SSH with (push) suffix',
  },
  {
    input: 'origin  git@github.com:cnlangzi/gfwproxy',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub SSH without suffix',
  },
  {
    input: 'origin  git@github.com:cnlangzi/gfwproxy.git',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub SSH with .git suffix',
  },
  {
    input: 'origin  git@github.com:cnlangzi/gfwproxy.git (fetch)',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub SSH with .git + (fetch)',
  },

  // Basic GitHub HTTPS
  {
    input: 'origin  https://github.com/cnlangzi/gfwproxy',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub HTTPS without .git',
  },
  {
    input: 'origin  https://github.com/cnlangzi/gfwproxy.git',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub HTTPS with .git',
  },
  {
    input: 'origin  https://github.com/cnlangzi/gfwproxy.git (fetch)',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'GitHub HTTPS with .git + (fetch)',
  },

  // Non-GitHub (GitLab, self-hosted, IP, etc.)
  {
    input: 'origin  git@gitlab.com:mygroup/myrepo (fetch)',
    expected: { owner: 'mygroup', repo: 'myrepo' },
    label: 'GitLab SSH',
  },
  {
    input: 'origin  https://gitlab.com/mygroup/myrepo.git',
    expected: { owner: 'mygroup', repo: 'myrepo' },
    label: 'GitLab HTTPS',
  },
  {
    input: 'origin  git@192.168.1.1:devops/tool.git (fetch)',
    expected: { owner: 'devops', repo: 'tool' },
    label: 'IP address SSH',
  },
  {
    input: 'origin  ssh://git@github.com/cnlangzi/gfwproxy.git (fetch)',
    expected: { owner: 'cnlangzi', repo: 'gfwproxy' },
    label: 'SSH protocol explicit URL',
  },
  {
    input: 'origin  ssh://git@192.168.1.1/cnlangzi/repo.git',
    expected: { owner: 'cnlangzi', repo: 'repo' },
    label: 'SSH protocol with IP',
  },
  {
    input: 'origin  git@code.example.com:team/special-repo.git (push)',
    expected: { owner: 'team', repo: 'special-repo' },
    label: 'Self-hosted GitHub Enterprise',
  },

  // Multi-word repo names (hyphens, underscores)
  {
    input: 'origin  git@github.com:coder/my-awesome-project.git (fetch)',
    expected: { owner: 'coder', repo: 'my-awesome-project' },
    label: 'Hyphenated repo name',
  },
  {
    input: 'origin  https://github.com/cnlangzi/gfw_proxy.git',
    expected: { owner: 'cnlangzi', repo: 'gfw_proxy' },
    label: 'Underscore in repo name',
  },

  // Edge: double-space formatting
  {
    input: 'origin  git@github.com:org/repo (fetch)',
    expected: { owner: 'org', repo: 'repo' },
    label: 'Extra spaces before (fetch)',
  },
];

describe('parseRemoteLine', () => {
  for (const { input, expected, label } of TESTS) {
    it(`✓ ${label}`, () => {
      const result = parseRemoteLine(input);
      assert.deepStrictEqual(result, expected, `Input: "${input}"`);
    });
  }

  it('throws on empty input', () => {
    assert.throws(() => parseRemoteLine(''), /empty or not a string/);
  });

  it('throws on null/undefined', () => {
    assert.throws(() => parseRemoteLine(null), /empty or not a string/);
    assert.throws(() => parseRemoteLine(undefined), /empty or not a string/);
  });

  it('throws on unparseable line', () => {
    assert.throws(() => parseRemoteLine('origin  not-a-url-at-all'), /Cannot parse remote/);
    assert.throws(() => parseRemoteLine('origin  ftp://example.com/repo'), /Cannot parse remote/);
  });

  it('throws on owner-only URL (no slash)', () => {
    assert.throws(() => parseRemoteLine('origin  git@github.com:justowner'), /Cannot parse remote/);
    assert.throws(() => parseRemoteLine('origin  https://github.com/justowner'), /Cannot parse remote/);
  });
});

describe('getRemoteRepo (integration)', () => {
  it('parses real gfwproxy remote', () => {
    // This is the actual line from `git remote -v` in ~/workspace/gfwproxy
    const line = 'origin  git@github.com:cnlangzi/gfwproxy (fetch)';
    const { owner, repo } = parseRemoteLine(line);
    assert.strictEqual(owner, 'cnlangzi');
    assert.strictEqual(repo, 'gfwproxy');
  });
});
