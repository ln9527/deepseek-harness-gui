/** Type surface of scripts/patch-glm53.mjs for the vitest suite (the script itself is plain ESM). */

export type PatchFileStatus = 'patched' | 'missing' | 'skipped'

export interface PatchResult {
  file: string
  status: PatchFileStatus
  changed: boolean
}

export declare const GLM_53_ID: string

/** pi-ai provider data path inside a runtime tree, relative to `<versionsRoot>/<version>/`. */
export declare const PROVIDER_DATA_RELATIVE: string

export declare function buildGlm53Entry(
  glm52: Record<string, unknown>,
): Readonly<Record<string, unknown>>

export declare function patchCatalog(catalog: Record<string, any>): {
  catalog: Record<string, any>
  changed: boolean
}

export declare function applyToTree(versionsRoot: string, version: string): PatchResult[]

export declare function patchVersionsRoot(versionsRoot: string): PatchResult[]
