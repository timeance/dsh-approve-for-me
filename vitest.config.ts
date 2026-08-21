import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m
const generatedHarnessProject = '.vitest.harness.generated.json'
const harnessRoot = resolve(
  import.meta.dirname,
  process.env.DSH_HARNESS_ROOT ?? '../deepseek-harness',
)

function harnessProjects(): string[] {
  const configured = process.env.DSH_HARNESS_TSCONFIG
  if (configured === undefined) return ['tsconfig.vitest.json']

  const harnessTsconfig = resolve(import.meta.dirname, configured)
  if (!existsSync(harnessTsconfig)) {
    throw new Error(`DSH_HARNESS_TSCONFIG does not exist: ${harnessTsconfig}`)
  }
  const project = resolve(import.meta.dirname, generatedHarnessProject)
  writeFileSync(project, `${JSON.stringify({
    extends: harnessTsconfig,
    include: [
      'src/**/*.ts',
      'src/**/*.tsx',
      'tests/**/*.ts',
      'tests/**/*.tsx',
    ],
  }, null, 2)}\n`)
  process.once('exit', () => rmSync(project, { force: true }))
  return [project, harnessTsconfig]
}

function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  resolve: {
    alias: {
      // DSH rc1's published client bundle is a browser ModuleLoader
      // registration, so source-level tests must keep every runtime import on
      // the checked-out Harness source graph (including nested importers).
      '@deepseek-ai/dsh-client-runtime/client': resolve(
        harnessRoot,
        'packages/client/runtime/src/client/index.ts',
      ),
    },
  },
  plugins: [
    tsconfigPaths({
      root: import.meta.dirname,
      projects: harnessProjects(),
      // The rc1 source workspace lives beside this plugin, so its imports
      // must use the same DSH source aliases as imports from this package.
      loose: true,
    }),
    standardDecoratorPlugin(),
  ],
})
