import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative as relativePath, resolve as resolvePath, sep } from 'node:path'

import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

export const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-runtime/client',
] as const
/**
 * Builds the Node plugin and browser module-loader artifacts from TypeScript output.
 *
 * @param id Module-loader id and Cordis plugin package name.
 * @param nodeEntries TypeScript Host entry points.
 * @returns tsdown configurations for the Host and Web artifacts.
 */
export function clientBundle(id: string, nodeEntries: readonly string[]): UserConfig[] {
  return [
    {
      name: id,
      entry: [...nodeEntries],
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'node22',
      fixedExtension: false,
      sourcemap: true,
      clean: false,
      dts: false,
    },
    {
      name: id + '/client',
      entry: { client: 'src/client/index.ts' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      target: 'es2022',
      dts: false,
      sourcemap: true,
      clean: false,
      deps: {
        neverBundle: [...CLIENT_EXTERNALS],
        alwaysBundle: (moduleId: string) =>
          CLIENT_EXTERNALS.includes(moduleId as typeof CLIENT_EXTERNALS[number])
            ? undefined
            : true,
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      },
      plugins: [
        {
          name: 'dsh-client-bundle-purity',
          resolveId(source: string) {
            if (!source.startsWith('@deepseek-ai/')) return null
            if (CLIENT_EXTERNALS.includes(source as typeof CLIENT_EXTERNALS[number])) return null
            if (VENDORED_LIBRARY.test(source)) return null
            if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
            throw new Error(
              'client bundle purity: "' + source + '" is not a platform module, inline-safe wire layer, '
              + 'vendored library, or generated /remote contribution',
            )
          },
        },
        {
          name: 'dsh-css-modules-inline',
          resolveId(source: string, importer: string | undefined) {
            if (!source.endsWith('.module.css')) return null
            const absolute = importer === undefined ? source : sourceAssetPath(source, importer)
            const relative = relativePath(process.cwd(), absolute).split(sep).join('/')
            if (relative === '..' || relative.startsWith('../')) {
              throw new Error('CSS module is outside the package root: ' + absolute)
            }
            return CSS_VIRTUAL_PREFIX + relative + CSS_VIRTUAL_SUFFIX
          },
          async load(virtualId: string) {
            if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
            const sourceId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
            const fileId = resolvePath(process.cwd(), sourceId)
            this.addWatchFile(fileId)
            const source = await readFile(fileId)
            const compiled = transform({
              filename: fileId,
              code: source,
              cssModules: { pattern: '[hash]_[local]' },
              minify: true,
            })
            const classMap: Record<string, string> = {}
            for (const [local, value] of Object.entries(compiled.exports ?? {})
              .sort(([left], [right]) => left.localeCompare(right, 'en'))) {
              classMap[local] = value.name
            }
            const tagId = id + '/' + basename(fileId)
            return [
              'const css = ' + JSON.stringify(compiled.code.toString()) + ';',
              'const tagId = ' + JSON.stringify(tagId) + ';',
              'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
              '  const tag = document.createElement("style");',
              '  tag.dataset.plugin = ' + JSON.stringify(id) + ';',
              '  tag.dataset.pluginCss = tagId;',
              '  tag.textContent = css;',
              '  document.head.appendChild(tag);',
              '}',
              'export default ' + JSON.stringify(classMap) + ';',
            ].join('\n')
          },
        },
      ],
      outputOptions: {
        entryFileNames: 'client.js',
        banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {',
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = sep + 'lib' + sep + 'types' + sep
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
