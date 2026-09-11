import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

// Only changes the disposable CI checkout; release dependencies stay on latest.
const version = process.argv[2]
if (!['0.1.1-rc.2', '0.1.2-rc.1', '0.1.5-rc.2'].includes(version)) {
  throw new Error('Unsupported compatibility target: ' + version)
}
if (version !== '0.1.5-rc.2') {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const name of Object.keys(manifest.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
  }
  // This package did not exist in 0.1.1; later Slots declarations require it.
  if (version === '0.1.1-rc.2') delete manifest.devDependencies['@deepseek-ai/dsh-client-store']
  writeFileSync('package.json', JSON.stringify(manifest, null, 4) + '\n')
  const packages = [...new Set(readFileSync('pnpm-lock.yaml', 'utf8')
    .match(/@deepseek-ai\/dsh-[a-z0-9-]+/g))].sort()
  appendFileSync('pnpm-workspace.yaml', '\noverrides:\n' + packages
    .map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(version)}\n`).join(''))
}
// Do not let resolution silently add release-age exemptions.
appendFileSync('pnpm-workspace.yaml', '\nminimumReleaseAgeStrict: true\n')
