import { defineConfig } from 'tsdown'

import { clientBundle } from './tsdown.client.ts'

export default defineConfig(clientBundle('dsh-approve-for-me', ['src/index.ts']))
