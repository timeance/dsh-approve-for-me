import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'

const configuredRoot = process.env.DSH_HARNESS_ROOT
if (configuredRoot === undefined) {
  throw new Error('DSH_HARNESS_ROOT is required')
}

const projectRoot = process.cwd()
const harnessRoot = resolve(projectRoot, configuredRoot)
if (!existsSync(resolve(harnessRoot, 'package.json'))) {
  throw new Error('DSH_HARNESS_ROOT is not a Harness checkout: ' + harnessRoot)
}

function sourceFiles(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path))
    } else if (/\.[cm]?tsx?$/u.test(name)) {
      files.push(path)
    }
  }
  return files
}

const specifiers = new Set()
for (const root of ['src', 'tests']) {
  for (const file of sourceFiles(resolve(projectRoot, root))) {
    const source = readFileSync(file, 'utf8')
    let start = source.indexOf('@deepseek-ai/')
    while (start >= 0) {
      let end = start
      while (end < source.length && /[A-Za-z0-9@._\/-]/u.test(source[end])) end += 1
      specifiers.add(source.slice(start, end))
      start = source.indexOf('@deepseek-ai/', end)
    }
  }
}

function workspacePackageMap(directory, packages = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      workspacePackageMap(path, packages)
    } else if (entry.name === 'package.json') {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof manifest.name === 'string') packages.set(manifest.name, path)
    }
  }
  return packages
}

const harnessPackages = workspacePackageMap(harnessRoot)
function declarationFor(specifier) {
  const segments = specifier.split('/')
  const packageName = segments.slice(0, 2).join('/')
  const subpath = segments.length === 2 ? '.' : './' + segments.slice(2).join('/')
  const packageJsonPath = harnessPackages.get(packageName)
  if (packageJsonPath === undefined) {
    throw new Error('Harness tag does not contain required package ' + packageName)
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const exported = packageJson.exports?.[subpath]
  const types = typeof exported === 'object' && exported !== null
    ? exported.types
    : subpath === '.' ? packageJson.types : undefined
  if (typeof types !== 'string') {
    throw new Error('No public types entry for ' + specifier)
  }
  const declaration = resolve(dirname(packageJsonPath), types)
  if (!existsSync(declaration)) {
    throw new Error('Build DSH libraries before compatibility typecheck; missing ' + declaration)
  }
  return declaration.replaceAll('\\', '/')
}

const paths = Object.fromEntries(
  [...specifiers].sort().map(specifier => [specifier, [declarationFor(specifier)]]),
)
const generated = resolve(projectRoot, '.tsconfig.harness.generated.json')
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')

writeFileSync(generated, JSON.stringify({
  extends: './tsconfig.json',
  compilerOptions: { paths },
}, null, 2) + '\n')

try {
  console.log('Checking DSH declarations from ' + relative(projectRoot, harnessRoot))
  execFileSync(process.execPath, [tsc, '-p', generated, '--noEmit'], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
} finally {
  rmSync(generated, { force: true })
}
