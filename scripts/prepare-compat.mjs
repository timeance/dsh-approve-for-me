import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// Only changes the disposable CI checkout; release dependencies stay on latest.
const version = process.argv[2]
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const latest = manifest.devDependencies['@deepseek-ai/dsh-agent']
const supported = manifest.peerDependencies['@deepseek-ai/dsh-agent'].split(' || ')
if (!supported.includes(version)) {
  throw new Error('Unsupported compatibility target: ' + version)
}
if (version !== latest) {
  for (const name of Object.keys(manifest.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
  }
  if (version === '0.2.3-alpha.2') {
    manifest.dependencies['@deepseek-ai/schemastery'] = '~3.20.0-alpha.1'
    Object.assign(manifest.devDependencies, {
      '@deepseek-ai/cordis': '~4.2.0-alpha.1',
      '@deepseek-ai/cordis-plugin-include': '~1.2.0-alpha.1',
      '@deepseek-ai/cordis-plugin-loader': '~1.2.0-alpha.1',
      '@deepseek-ai/cordis-plugin-group': '~1.2.0-alpha.1',
    })
  } else if (!version.startsWith('0.2.2-')) {
    manifest.dependencies['@deepseek-ai/schemastery'] = '~3.18.5'
    Object.assign(manifest.devDependencies, {
      '@deepseek-ai/cordis': '~4.0.5',
      '@deepseek-ai/cordis-plugin-include': '~1.0.10',
      '@deepseek-ai/cordis-plugin-loader': '~1.0.6',
      '@deepseek-ai/cordis-plugin-group': '~1.0.5',
    })
  }
  // This package did not exist in 0.1.1; later Slots declarations require it.
  if (version === '0.1.1-rc.2') delete manifest.devDependencies['@deepseek-ai/dsh-client-store']
  writeFileSync('package.json', JSON.stringify(manifest, null, 4) + '\n')
  const packages = [...new Set([
    ...readFileSync('pnpm-lock.yaml', 'utf8').match(/@deepseek-ai\/dsh-[a-z0-9-]+/g),
    // Removed from 0.2, but old caret dependencies must not drift to rc.3.
    '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-code-runtime',
  ])].sort()
  appendFileSync('pnpm-workspace.yaml', '\noverrides:\n' + packages
    .map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(version)}\n`).join(''))
  // This job resolves a different dependency graph; the latest lockfile is not its input.
  rmSync('pnpm-lock.yaml')
}
// Do not let resolution silently add release-age exemptions.
appendFileSync('pnpm-workspace.yaml', '\nminimumReleaseAgeStrict: true\n')
