/// <reference types="@cloudflare/vitest-pool-workers" />
import type { Env } from '../src/index.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
