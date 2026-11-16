import { describe, expect, it } from 'vite-plus/test';

import {
  assertRunByPnpm,
  prereleaseLabel,
  verifyPublishTag,
} from './publishTag.mjs';

describe('prereleaseLabel', () => {
  it('returns the first prerelease identifier', () => {
    expect(prereleaseLabel('0.1.0-alpha.2')).toBe('alpha');
    expect(prereleaseLabel('1.0.0-beta')).toBe('beta');
    expect(prereleaseLabel('1.0.0-rc.1+build.5')).toBe('rc');
  });

  it('returns undefined for stable versions', () => {
    expect(prereleaseLabel('1.0.0')).toBeUndefined();
    expect(prereleaseLabel('1.0.0+build.5')).toBeUndefined();
  });

  it('throws on invalid versions', () => {
    expect(() => prereleaseLabel('1.0')).toThrow('not a valid semver');
  });
});

describe('verifyPublishTag', () => {
  it('accepts stable versions under the default tag', () => {
    expect(() => verifyPublishTag('1.0.0', undefined)).not.toThrow();
    expect(() => verifyPublishTag('1.0.0', '')).not.toThrow();
    expect(() => verifyPublishTag('1.0.0', 'latest')).not.toThrow();
  });

  it('rejects stable versions under a prerelease tag', () => {
    expect(() => verifyPublishTag('1.0.0', 'alpha')).toThrow(
      'Publishing stable version 1.0.0 under the "alpha" tag',
    );
    expect(() => verifyPublishTag('1.0.0', 'beta')).toThrow();
  });

  it('accepts prerelease versions under the matching tag', () => {
    expect(() => verifyPublishTag('0.1.0-alpha.2', 'alpha')).not.toThrow();
    expect(() => verifyPublishTag('0.2.0-beta.0', 'beta')).not.toThrow();
  });

  it('rejects prerelease versions under another tag', () => {
    expect(() => verifyPublishTag('0.1.0-alpha.2', undefined)).toThrow(
      'mismatched tag "latest". Use --tag alpha',
    );
    expect(() => verifyPublishTag('0.1.0-alpha.2', 'latest')).toThrow();
    expect(() => verifyPublishTag('0.1.0-alpha.2', 'beta')).toThrow();
  });

  it('does not match a label that only appears inside the version', () => {
    // `version.includes('alpha')` used to match this one.
    expect(() => verifyPublishTag('1.0.0-rc.1+alpha', 'alpha')).toThrow(
      'Unknown prerelease label "rc"',
    );
  });

  it('rejects unknown prerelease labels', () => {
    expect(() => verifyPublishTag('1.0.0-rc.1', 'rc')).toThrow(
      'Unknown prerelease label "rc"',
    );
  });
});

describe('assertRunByPnpm', () => {
  it('accepts pnpm 10', () => {
    expect(() =>
      assertRunByPnpm('pnpm/10.6.3 npm/? node/v22.0.0 darwin arm64'),
    ).not.toThrow();
  });

  it('rejects a missing user agent', () => {
    expect(() => assertRunByPnpm(undefined)).toThrow(
      'must be executed by pnpm',
    );
  });

  it('rejects npm', () => {
    expect(() =>
      assertRunByPnpm('npm/10.9.0 node/v22.0.0 darwin arm64 workspaces/false'),
    ).toThrow('must be executed by pnpm');
  });

  it('rejects pnpm 11, which hides --tag from scripts', () => {
    expect(() =>
      assertRunByPnpm('pnpm/11.24.0 npm/? node/v26.0.0 darwin arm64'),
    ).toThrow('does not pass the --tag flag');
  });
});
