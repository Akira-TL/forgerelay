import { resolve } from "node:path";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface AdvertisedFileSource {
  filePath: string;
  baseDir: string;
}

export interface AdvertisedFileReadResolution<TSource extends AdvertisedFileSource> {
  absolutePath: string;
  source: TSource;
  isEntryFile: boolean;
}

export function resolveAdvertisedFileReadPath<TSource extends AdvertisedFileSource>(
  sources: readonly TSource[],
  activatedDirs: Set<string>,
  inputPath: string,
): AdvertisedFileReadResolution<TSource> | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const source of sources) {
    const entryFilePath = resolve(source.filePath);
    if (absolutePath === entryFilePath) {
      return { absolutePath, source, isEntryFile: true };
    }
  }

  for (const source of sources) {
    const baseDir = resolve(source.baseDir);
    if (!activatedDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, source, isEntryFile: false };
  }

  return undefined;
}

export function markAdvertisedFileSourceActivated(
  activatedDirs: Set<string>,
  source: AdvertisedFileSource,
): void {
  activatedDirs.add(resolve(source.baseDir));
}
